import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

interface CheckoutProps {
  monto: number;
  reservaId: string;
}

const supabaseUrl = 'https://xgzychlstszohebfjhzi.supabase.co';
const supabaseKey = 'sb_publishable_ZEvZQ7WQLnC2JZ0XNuD-ug_1SLmB7AU';
const supabase = createClient(supabaseUrl, supabaseKey);

const OnvoCheckout: React.FC<CheckoutProps> = ({ monto, reservaId }) => {
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    const channel = supabase
      .channel('reservas-changes')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'reservas' }, (payload) => {
        console.log('Cambio detectado en reservas:', payload);
        // Actualizar el estado o UI según sea necesario
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const manejarPago = async () => {
    setCargando(true);

    try {
      const response = await fetch('https://pdzkttgrgxkbbyvfnzij.supabase.co/functions/v1/checkout-onvo', {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reservaId,
          monto,
          moneda: 'USD',
          clienteNombre: 'Cliente de prueba',
        }),
      });

      const data = await response.json();

      const checkoutUrl = String(
        data?.checkoutUrl ?? data?.checkout_url ?? data?.checkout?.url ?? data?.url ?? ''
      );
      const checkoutSessionId = String(
        data?.checkoutSessionId ?? data?.checkout_session_id ?? data?.sessionId ?? data?.session_id ?? ''
      );
      const paymentIntentId = String(data?.paymentIntentId ?? data?.payment_intent_id ?? data?.id ?? '');

      if (!response.ok) {
        console.error("Respuesta de la Edge Function:", data);
        throw new Error("La Edge Function devolvió un error al crear el pago.");
      }

      const destino = checkoutUrl || (checkoutSessionId ? `https://checkout.onvopay.com/pay/${checkoutSessionId}` : '');

      if (!destino) {
        console.error("No se encontró checkout_url ni checkout_session_id en la respuesta:", data);
        throw new Error("Onvo no devolvió una sesión de checkout válida.");
      }

      console.log("Intent de pago creado:", paymentIntentId);
      console.log("Redirigiendo al checkout de OnvoPay:", destino);
      window.location.href = destino;
    } catch (error) {
      console.error("Error al manejar el pago:", error);
      alert("No se pudo completar el proceso de pago.");
    } finally {
      setCargando(false);
    }
  };

  return (
    <div style={{ padding: '20px', border: '1px solid #ddd', borderRadius: '8px' }}>
      <h3>Resumen de Reserva: #{reservaId}</h3>
      <p>
        Total a pagar: <strong>${monto}</strong>
      </p>

      <button
        onClick={manejarPago}
        disabled={cargando}
        style={{ padding: '10px 20px', cursor: 'pointer' }}
      >
        {cargando ? 'Procesando...' : 'Pagar con Onvo'}
      </button>
    </div>
  );
};

export default OnvoCheckout;