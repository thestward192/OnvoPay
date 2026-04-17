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

    console.log('Datos enviados a OnvoPay:', {
      amount: monto,
      currency: moneda,
      description: `Pago reserva #${reservaGuardadaId}`,
      metadata: {
        reservaId: reservaGuardadaId,
        monto,
        moneda,
        clienteNombre,
      },
    });

    console.log('Respuesta completa de OnvoPay:', raw);

    const onvoResponse = await fetch('https://api.onvopay.com/v1/payment-intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${onvoSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: monto,
        currency: moneda,
        description: `Pago reserva #${reservaGuardadaId}`,
        metadata: {
          reservaId: reservaGuardadaId,
          monto,
          moneda,
          clienteNombre,
        },
      }),
    });

    const raw = await onvoResponse.text();
    console.log('Respuesta de OnvoPay:', raw);

    const onvoData = raw ? JSON.parse(raw) : {};

    if (!onvoResponse.ok || !onvoData?.id) {
      console.error('Error al generar el intent de pago en OnvoPay:', onvoData);
      await actualizarReserva(reservaGuardadaId, { estado: 'fallido' });
      return jsonResponse(
        { error: 'Error al generar el intent de pago en OnvoPay', details: onvoData },
        onvoResponse.status || 500
      );
    }

    // Verificar si OnvoPay devuelve un enlace de checkout
    const checkoutUrl = onvoData?.checkout_url || `https://checkout.onvopay.com/pay/${onvoData.id}`;

    await actualizarReserva(reservaGuardadaId, {
      onvo_payment_intent_id: onvoData.id,
      estado: 'pendiente',
    });

    return jsonResponse({ paymentIntentId: onvoData.id, reservaId: reservaGuardadaId, checkoutUrl }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (reservaGuardadaId) {
      await actualizarReserva(reservaGuardadaId, { estado: 'fallido' });
    }

    console.error('Error en la Edge Function:', message);
    return jsonResponse({ error: message }, 400);
  }
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const intentId = body?.intent_id;
    const status = body?.status;

    if (!intentId || !status) {
      return jsonResponse({ error: 'Missing intent_id or status' }, 400);
    }

    const { url, key } = getSupabaseConfig();

    // Fetch the reservation linked to the intent_id
    const reservaResponse = await fetch(`${url}/rest/v1/reservas?onvo_payment_intent_id=eq.${intentId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
    });

    if (!reservaResponse.ok) {
      const error = await reservaResponse.text();
      throw new Error(`Error fetching reservation: ${error}`);
    }

    const reservas = await reservaResponse.json();
    const reserva = reservas[0];

    if (!reserva) {
      return jsonResponse({ error: 'Reservation not found' }, 404);
    }

    // Update reservation status
    const updateResponse = await fetch(`${url}/rest/v1/reservas?id=eq.${reserva.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ estado: status === 'succeeded' ? 'pagado' : 'fallido' }),
    });

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      throw new Error(`Error updating reservation: ${error}`);
    }

    // If payment succeeded, update prueba_reservas
    if (status === 'succeeded') {
      await fetch(`${url}/rest/v1/prueba_reservas?id=eq.${reserva.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${key}`,
          apikey: key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ estado: 'alquilado' }),
      });
    }

    return jsonResponse({ message: 'Reservation updated successfully' }, 200);
  } catch (error) {
    console.error('Error in notification handler:', error);
    return jsonResponse({ error: error.message }, 500);
  }
});
