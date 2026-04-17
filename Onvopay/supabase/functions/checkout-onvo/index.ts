declare const Deno: {
  env: {
    get: (key: string) => string | undefined;
  };
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
};

// Funcion de prueba: crea una reserva y solicita un Payment Intent a Onvo.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });

const safeJsonParse = (raw: string) => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { raw };
  }
};

const getFirstString = (values: Array<unknown>) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return '';
};

const getSupabaseConfig = () => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE key in Edge Function secrets');
  }

  return { url, key };
};

const insertarReservaPendiente = async (payload: {
  clienteNombre: string;
  monto: number;
  moneda: string;
}) => {
  const { url, key } = getSupabaseConfig();

  const response = await fetch(`${url}/rest/v1/reservas`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      cliente_nombre: payload.clienteNombre,
      monto: payload.monto,
      moneda: payload.moneda,
      estado: 'pendiente',
      onvo_payment_intent_id: null,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`No se pudo guardar la reserva: ${error}`);
  }

  const rows = (await response.json()) as Array<{ id: string }>;
  if (!rows[0]?.id) {
    throw new Error('La base de datos no devolvio el id de reserva');
  }

  return rows[0].id;
};

const actualizarReserva = async (id: string, data: Record<string, unknown>) => {
  const { url, key } = getSupabaseConfig();

  const response = await fetch(`${url}/rest/v1/reservas?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('No se pudo actualizar la reserva:', error);
  }
};

const guardarPago = async (payload: {
  reserva_id: string;
  nombre_cliente: string;
  monto: number;
  moneda: string;
  estado_pago: string;
  onvo_payment_intent_id?: string | null;
  onvo_checkout_session_id?: string | null;
  checkout_url?: string | null;
  metadata?: Record<string, unknown>;
}) => {
  const { url, key } = getSupabaseConfig();

  const response = await fetch(`${url}/rest/v1/pagos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('No se pudo guardar el pago:', error);
    return null;
  }

  const rows = (await response.json()) as Array<{ id: string }>;
  return rows[0]?.id || null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  let reservaGuardadaId = '';

  try {
    const body = await req.json();
    const reservaId = String(body?.reservaId ?? '');
    const monto = Number(body?.monto ?? 0);
    const moneda = String(body?.moneda ?? '');
    const clienteNombre = String(body?.clienteNombre ?? reservaId ?? 'Cliente demo');

    if (!reservaId || !monto || !moneda) {
      return jsonResponse({ error: 'Missing required fields: reservaId, monto, moneda' }, 400);
    }

    reservaGuardadaId = await insertarReservaPendiente({ clienteNombre, monto, moneda });

    const onvoSecretKey = Deno.env.get('ONVO_SECRET_KEY');
    if (!onvoSecretKey) {
      await actualizarReserva(reservaGuardadaId, { estado: 'fallido' });
      return jsonResponse(
        { error: 'Missing ONVO_SECRET_KEY in Edge Function secrets', reservaId: reservaGuardadaId },
        500
      );
    }

    const onvoHeaders = {
      Authorization: `Bearer ${onvoSecretKey}`,
      'Content-Type': 'application/json',
    };

    const description = `Pago reserva #${reservaGuardadaId}`;
    const metadata = {
      reservaId: reservaGuardadaId,
      reservaOrigenId: reservaId,
      clienteNombre,
    };

    const checkoutSessionEndpoint = 'https://api.onvopay.com/v1/checkout/sessions/one-time-link';
    const checkoutLineItemDescription = `Reserva ${reservaId}`;
    const redirectUrl = typeof body?.redirectUrl === 'string' ? body.redirectUrl : null;
    const cancelUrl = typeof body?.cancelUrl === 'string' ? body.cancelUrl : null;

    const checkoutSessionPayloads = [
      {
        customerName: clienteNombre,
        redirectUrl,
        cancelUrl,
        lineItems: [
          {
            description: checkoutLineItemDescription,
            unitAmount: monto,
            currency: moneda,
            quantity: 1,
          },
        ],
        metadata,
      },
      {
        customerName: clienteNombre,
        redirectUrl,
        cancelUrl,
        lineItems: [
          {
            description: checkoutLineItemDescription,
            unitAmount: monto,
            currency: moneda,
            quantity: 1,
          },
        ],
        metadata,
      },
      {
        customerName: clienteNombre,
        redirectUrl,
        cancelUrl,
        lineItems: [
          {
            description: checkoutLineItemDescription,
            amountTotal: monto,
            currency: moneda,
            quantity: 1,
          },
        ],
        metadata,
      },
    ];

    let checkoutSessionResponse: Record<string, unknown> | null = null;
    const sessionErrors: Array<Record<string, unknown>> = [];

    for (const payload of checkoutSessionPayloads) {
      const sessionResp = await fetch(checkoutSessionEndpoint, {
        method: 'POST',
        headers: onvoHeaders,
        body: JSON.stringify(payload),
      });

      const sessionRaw = await sessionResp.text();
      const sessionData = safeJsonParse(sessionRaw) as Record<string, unknown>;

      if (sessionResp.ok) {
        checkoutSessionResponse = sessionData;
        break;
      }

      sessionErrors.push({
        endpoint: checkoutSessionEndpoint,
        payload,
        status: sessionResp.status,
        response: sessionData,
      });
    }

    if (checkoutSessionResponse) {
      const checkoutUrl = getFirstString([
        checkoutSessionResponse.checkout_url,
        checkoutSessionResponse.checkoutUrl,
        checkoutSessionResponse.url,
        (checkoutSessionResponse.checkout as { url?: unknown } | undefined)?.url,
      ]);

      const checkoutSessionId = getFirstString([
        checkoutSessionResponse.id,
        checkoutSessionResponse.checkout_session_id,
        checkoutSessionResponse.checkoutSessionId,
        checkoutSessionResponse.session_id,
        checkoutSessionResponse.sessionId,
      ]);

      const paymentIntentId = getFirstString([
        checkoutSessionResponse.payment_intent_id,
        checkoutSessionResponse.paymentIntentId,
        checkoutSessionResponse.payment_intent,
      ]);

      const finalCheckoutUrl = checkoutUrl || (checkoutSessionId ? `https://checkout.onvopay.com/pay/${checkoutSessionId}` : '');

      if (finalCheckoutUrl) {
        await actualizarReserva(reservaGuardadaId, {
          onvo_payment_intent_id: paymentIntentId || null,
          estado: 'pendiente',
        });

        // Guardar el pago en la tabla pagos
        await guardarPago({
          reserva_id: reservaGuardadaId,
          nombre_cliente: clienteNombre,
          monto,
          moneda,
          estado_pago: 'pendiente',
          onvo_payment_intent_id: paymentIntentId || null,
          onvo_checkout_session_id: checkoutSessionId || null,
          checkout_url: finalCheckoutUrl,
          metadata: {
            lineItems: checkoutSessionResponse.lineItems,
            provider: 'checkout-session',
          },
        });

        return jsonResponse(
          {
            reservaId: reservaGuardadaId,
            checkoutUrl: finalCheckoutUrl,
            checkoutSessionId,
            paymentIntentId,
            provider: 'checkout-session',
            onvoRaw: checkoutSessionResponse,
          },
          200
        );
      }
    }

    const intentResp = await fetch('https://api.onvopay.com/v1/payment-intents', {
      method: 'POST',
      headers: onvoHeaders,
      body: JSON.stringify({
        amount: monto,
        currency: moneda,
        description,
        metadata,
      }),
    });

    const intentRaw = await intentResp.text();
    const intentData = safeJsonParse(intentRaw) as Record<string, unknown>;

    if (!intentResp.ok) {
      await actualizarReserva(reservaGuardadaId, { estado: 'fallido' });

      // Guardar el pago fallido en la tabla pagos
      await guardarPago({
        reserva_id: reservaGuardadaId,
        nombre_cliente: clienteNombre,
        monto,
        moneda,
        estado_pago: 'fallido',
        metadata: {
          error: 'No se pudo crear payment intent en Onvo',
          sessionErrors,
          intentError: intentData,
        },
      });

      return jsonResponse(
        {
          error: 'No se pudo crear checkout session ni payment intent en Onvo.',
          checkoutSessionErrors: sessionErrors,
          paymentIntentError: intentData,
        },
        intentResp.status
      );
    }

    const checkoutUrlFromIntent = getFirstString([
      intentData.checkout_url,
      intentData.checkoutUrl,
      intentData.url,
      (intentData.checkout as { url?: unknown } | undefined)?.url,
    ]);

    const checkoutSessionIdFromIntent = getFirstString([
      intentData.checkout_session_id,
      intentData.checkoutSessionId,
      intentData.session_id,
      intentData.sessionId,
    ]);

    const paymentIntentId = getFirstString([intentData.id, intentData.payment_intent_id, intentData.paymentIntentId]);

    await actualizarReserva(reservaGuardadaId, {
      onvo_payment_intent_id: paymentIntentId || null,
      estado: 'pendiente',
    });

    return jsonResponse(
      {
        ...intentData,
        reservaId: reservaGuardadaId,
        checkoutUrl: checkoutUrlFromIntent,
        checkoutSessionId: checkoutSessionIdFromIntent,
        paymentIntentId,
        provider: 'payment-intent-fallback',
        checkoutSessionErrors: sessionErrors,
      },
      200
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (reservaGuardadaId) {
      await actualizarReserva(reservaGuardadaId, { estado: 'fallido' });
    }

    console.error('Error en la Edge Function:', message);
    return jsonResponse({ error: message }, 400);
  }
});
