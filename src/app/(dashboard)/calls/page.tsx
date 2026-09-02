'use client';

import { useState } from 'react';
import { Phone, Headset, Settings2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { VoicePanel } from '@/components/voice/voice-panel';
import { TelnyxConfig } from '@/components/settings/telnyx-config';
import { TwilioConfig } from '@/components/settings/twilio-config';
import { ProviderRouting, type Routing } from '@/components/settings/provider-routing';

export default function CallsPage() {
  // El panel que se muestra lo decide el routing de VOZ. El de SMS puede
  // ser distinto (una cuenta puede tener la voz en Twilio y el SMS en
  // Telnyx), pero las credenciales son las mismas por proveedor, así que
  // se enseñan las de ambos cuando divergen.
  const [routing, setRouting] = useState<Routing | null>(null);
  const providers = routing
    ? Array.from(new Set([routing.voice, routing.sms]))
    : ['telnyx'];

  return (
    <div>
      <div className="flex items-center gap-2">
        <Phone className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Phone
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Make and receive calls — softphone, call history, and the Telnyx or
        Twilio configuration behind them.
      </p>

      <Tabs defaultValue="softphone" className="mt-6">
        <TabsList>
          <TabsTrigger value="softphone">
            <Headset className="mr-1.5 h-4 w-4" /> Softphone
          </TabsTrigger>
          <TabsTrigger value="setup">
            <Settings2 className="mr-1.5 h-4 w-4" /> Setup
          </TabsTrigger>
        </TabsList>

        <TabsContent value="softphone" className="mt-4">
          <div className="flex h-[560px] flex-col overflow-hidden rounded-xl border bg-card">
            <VoicePanel />
          </div>
        </TabsContent>

        <TabsContent value="setup" className="mt-4">
          <div className="space-y-6">
            <ProviderRouting channels={['voice', 'sms']} onChange={setRouting} />
            {providers.includes('telnyx') && <TelnyxConfig />}
            {providers.includes('twilio') && <TwilioConfig />}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
