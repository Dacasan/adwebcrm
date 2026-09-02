'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Route } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ============================================================
// Selector de proveedor POR CANAL. Una clínica puede tener la voz en
// Twilio y el email en Resend, así que no hay un interruptor global.
//
// Cambiar de proveedor con llamadas activas AVISA, no bloquea: bloquear
// obligaría a esperar a que el último paciente cuelgue para poder tocar
// una configuración, y eso convierte un ajuste en una incidencia.
//
// El canal `email` está soportado por este componente pero NO se
// renderiza en ninguna pantalla: producto ha decidido que el correo se
// queda en Resend, y un desplegable que nadie va a usar solo sirve para
// que un clic por curiosidad deje la cuenta enviando por un proveedor sin
// credenciales. El interruptor sigue existiendo en la API para el día que
// haga falta: `PUT /api/providers/routing`, rol owner.
//
// Los textos van literales, como en el resto de la pantalla de Teléfono
// (`components/voice/*`), en vez de por `next-intl`.
// ============================================================

export type Channel = 'voice' | 'sms' | 'email';

export interface Routing {
  voice: 'telnyx' | 'twilio';
  sms: 'telnyx' | 'twilio';
  email: 'resend' | 'sendgrid';
}

const OPTIONS: Record<Channel, { value: string; label: string }[]> = {
  voice: [
    { value: 'telnyx', label: 'Telnyx' },
    { value: 'twilio', label: 'Twilio' },
  ],
  sms: [
    { value: 'telnyx', label: 'Telnyx' },
    { value: 'twilio', label: 'Twilio' },
  ],
  email: [
    { value: 'resend', label: 'Resend' },
    { value: 'sendgrid', label: 'SendGrid' },
  ],
};

const LABELS: Record<Channel, { title: string; hint: string }> = {
  voice: { title: 'Voice', hint: 'Softphone, inbound calls and recordings.' },
  sms: { title: 'SMS', hint: 'Outbound automations and the inbound inbox.' },
  email: { title: 'Email', hint: 'Transactional email and campaigns.' },
};

/** Fetch del routing actual. Exportado para que las páginas lo compartan. */
export async function fetchRouting(): Promise<Routing | null> {
  const res = await fetch('/api/providers/routing');
  if (!res.ok) return null;
  return (await res.json()) as Routing;
}

export function ProviderRouting({
  channels,
  onChange,
  /** Se avisa —no se bloquea— si hay una llamada en curso. */
  hasActiveCall = false,
}: {
  channels: Channel[];
  onChange?: (routing: Routing) => void;
  hasActiveCall?: boolean;
}) {
  const [routing, setRouting] = useState<Routing | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Channel | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchRouting();
      setRouting(data);
      if (data) onChange?.(data);
    } finally {
      setLoading(false);
    }
    // `onChange` se omite a propósito: los llamantes pasan una lambda
    // nueva en cada render y meterla en las deps re-dispararía el fetch
    // en bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function change(channel: Channel, value: string) {
    if (!routing) return;
    if (channel === 'voice' && hasActiveCall) {
      toast.warning('There is a call in progress — it will keep running on the current provider.');
    }
    setSaving(channel);
    try {
      const res = await fetch('/api/providers/routing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [channel]: value }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Could not change provider');
        return;
      }
      setRouting(data as Routing);
      onChange?.(data as Routing);
      toast.success(`${LABELS[channel].title} now runs on ${value}`);
    } catch {
      toast.error('Could not change provider');
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Route className="size-4 text-primary" />
          Provider
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Chosen per channel. Switching only affects new traffic — anything already in flight
          finishes on the provider that started it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading || !routing ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : (
          channels.map((channel) => (
            <div key={channel} className="space-y-2">
              <Label className="text-muted-foreground">{LABELS[channel].title}</Label>
              <Select
                value={routing[channel]}
                onValueChange={(v) => void change(channel, v ?? '')}
                disabled={saving === channel}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPTIONS[channel].map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{LABELS[channel].hint}</p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
