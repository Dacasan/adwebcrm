'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Zap,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

// ============================================================
// Twilio config (voz + SMS). owner-only (RLS).
//
// Tres cosas que esta pantalla hace y que no son decorativas:
//
//  1. Enseña las URLs de webhook YA construidas, con botón de copiar. Es
//     el paso donde más gente se atasca, porque la firma se calcula sobre
//     la URL completa y una barra de más la invalida entera.
//  2. Permite ROTAR el token de webhook, avisando de que hay que repegar
//     las URLs en la consola de Twilio.
//  3. Muestra el estado de compliance por geografía. Los plazos de A2P
//     10DLC (hasta 20 días hábiles) tienen que verse durante el
//     onboarding, no cuando el cliente intente enviar y le rebote un
//     30034.
//
// NUNCA se pinta un secreto: el GET devuelve `has_auth_token`, no el
// token.
// ============================================================

const MASKED = '••••••••••••••••••••';

interface WebhookUrls {
  voice: string;
  voice_status: string;
  voice_action: string;
  voice_recording: string;
  sms_inbound: string;
  sms_status: string;
}

interface TwilioConfigResponse {
  configured: boolean;
  /** null cuando falta TWILIO_WEBHOOK_BASE_URL en el servidor. */
  account_sid?: string;
  has_auth_token?: boolean;
  has_api_key?: boolean;
  api_key_sid?: string | null;
  twiml_app_sid?: string | null;
  messaging_service_sid?: string | null;
  default_from_number?: string | null;
  fallback_number?: string | null;
  recording_enabled?: boolean;
  regulatory_bundle_sid?: string | null;
  address_sid?: string | null;
  webhook_urls?: WebhookUrls | null;
}

const WEBHOOK_LABELS: { key: keyof WebhookUrls; label: string; where: string }[] = [
  { key: 'voice', label: 'Voice', where: 'Phone Number › Voice › A call comes in' },
  { key: 'sms_inbound', label: 'SMS inbound', where: 'Phone Number › Messaging › A message comes in' },
  { key: 'voice_status', label: 'Call status', where: 'set automatically by the TwiML we return' },
  { key: 'voice_action', label: 'Dial action', where: 'set automatically by the TwiML we return' },
  { key: 'voice_recording', label: 'Recording', where: 'set automatically when recording is on' },
  { key: 'sms_status', label: 'SMS status', where: 'set automatically on every outbound message' },
];

function CopyRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-muted-foreground">{label}</Label>
      <div className="flex gap-2">
        <Input
          readOnly
          value={value}
          className="bg-muted border-border text-muted-foreground font-mono text-xs"
        />
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          onClick={() => {
            navigator.clipboard.writeText(value);
            toast.success('Copied');
          }}
          aria-label={`Copy ${label} URL`}
        >
          <Copy className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function TwilioConfig() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<TwilioConfigResponse | null>(null);

  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [messagingServiceSid, setMessagingServiceSid] = useState('');
  const [defaultFromNumber, setDefaultFromNumber] = useState('');
  const [fallbackNumber, setFallbackNumber] = useState('');
  const [bundleSid, setBundleSid] = useState('');
  const [addressSid, setAddressSid] = useState('');
  const [recordingEnabled, setRecordingEnabled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/twilio/config');
      if (!res.ok) {
        setConfig(null);
        return;
      }
      const data = (await res.json()) as TwilioConfigResponse;
      setConfig(data);
      setAccountSid(data.account_sid ?? '');
      setAuthToken(data.configured ? MASKED : '');
      setTokenEdited(false);
      setMessagingServiceSid(data.messaging_service_sid ?? '');
      setDefaultFromNumber(data.default_from_number ?? '');
      setFallbackNumber(data.fallback_number ?? '');
      setBundleSid(data.regulatory_bundle_sid ?? '');
      setAddressSid(data.address_sid ?? '');
      setRecordingEnabled(data.recording_enabled === true);
    } catch {
      toast.error('Failed to load Twilio configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(extra: Record<string, unknown> = {}) {
    const payload: Record<string, unknown> = {
      account_sid: accountSid.trim(),
      messaging_service_sid: messagingServiceSid.trim(),
      default_from_number: defaultFromNumber.trim(),
      fallback_number: fallbackNumber.trim(),
      regulatory_bundle_sid: bundleSid.trim(),
      address_sid: addressSid.trim(),
      recording_enabled: recordingEnabled,
      ...extra,
    };
    if (tokenEdited && authToken.trim() && authToken !== MASKED) {
      payload.auth_token = authToken.trim();
    }

    const res = await fetch('/api/twilio/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || 'Could not save Twilio configuration');
      return false;
    }
    await load();
    return true;
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (await save()) toast.success('Twilio configuration saved');
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate() {
    setRotating(true);
    try {
      if (await save({ rotate_webhook_token: true })) {
        toast.success('Webhook token rotated — paste the new URLs in the Twilio console');
      }
    } finally {
      setRotating(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const configured = config?.configured === true;
  const urls = config?.webhook_urls;

  return (
    <div className="space-y-6">
      <Alert className="bg-card border-border">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-primary" />
          <AlertTitle className="text-foreground mb-0">
            {configured ? 'Twilio connected' : 'Twilio not configured'}
          </AlertTitle>
        </div>
        <AlertDescription className="text-muted-foreground">
          Bring your own Twilio account: the Account SID and Auth Token below are this
          workspace&apos;s own. The API key and TwiML app are created automatically the first time
          the softphone asks for a token.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Credentials</CardTitle>
          <CardDescription className="text-muted-foreground">
            From Twilio Console › Account Info. Validated against Twilio before saving.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Account SID</Label>
            <Input
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
              className="bg-muted border-border font-mono"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Auth Token</Label>
            <div className="relative">
              <Input
                type={showToken ? 'text' : 'password'}
                placeholder="your auth token"
                value={authToken}
                onFocus={() => {
                  if (authToken === MASKED) {
                    setAuthToken('');
                    setTokenEdited(true);
                  }
                }}
                onChange={(e) => {
                  setAuthToken(e.target.value);
                  setTokenEdited(true);
                }}
                className="bg-muted border-border pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {configured && !tokenEdited && (
              <p className="text-xs text-muted-foreground">
                Stored encrypted. Leave it as-is to keep the current token.
              </p>
            )}
            {tokenEdited && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                Rotating the Auth Token invalidates webhook signatures already in flight — there is
                a short cut-over window where Twilio retries may be rejected.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Messaging Service SID</Label>
              <Input
                placeholder="MGxxxxxxxx"
                value={messagingServiceSid}
                onChange={(e) => setMessagingServiceSid(e.target.value)}
                className="bg-muted border-border font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Preferred over a bare number: required by A2P 10DLC in the US, and what gives
                geo-match and sticky sender internationally.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Default number (E.164)</Label>
              <Input
                placeholder="+34910000000"
                value={defaultFromNumber}
                onChange={(e) => setDefaultFromNumber(e.target.value)}
                className="bg-muted border-border font-mono"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Fallback number</Label>
            <Input
              placeholder="+34699888777"
              value={fallbackNumber}
              onChange={(e) => setFallbackNumber(e.target.value)}
              className="bg-muted border-border font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Where an inbound call goes when nobody has the softphone open. Without it the call
              falls through to voicemail.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Call recording</CardTitle>
          <CardDescription className="text-muted-foreground">
            Off by default, and deliberately so.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">Record answered calls</p>
              <p className="text-xs text-muted-foreground">
                Recordings are stored in a private bucket and served through an authenticated proxy.
              </p>
            </div>
            <Switch checked={recordingEnabled} onCheckedChange={setRecordingEnabled} />
          </div>
          {recordingEnabled && (
            <Alert className="border-amber-500/40 bg-amber-500/5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-amber-600" />
                <AlertTitle className="mb-0 text-foreground">Legal notice</AlertTitle>
              </div>
              <AlertDescription className="text-muted-foreground">
                Spain requires informing the other party before recording, and several US states
                require two-party consent. Turning this on is your decision to make and to announce.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {configured && !urls && (
        <Alert className="border-amber-500/40 bg-amber-500/5">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-600" />
            <AlertTitle className="mb-0 text-foreground">
              Webhook URLs unavailable
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            The server has no public base URL configured. Set
            <code className="px-1 font-mono text-xs">TWILIO_WEBHOOK_BASE_URL</code>
            (or <code className="px-1 font-mono text-xs">NEXT_PUBLIC_SITE_URL</code>) and redeploy —
            without it the signature cannot be verified and every Twilio callback is rejected.
          </AlertDescription>
        </Alert>
      )}

      {configured && urls && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Webhook URLs</CardTitle>
            <CardDescription className="text-muted-foreground">
              Paste the first two in the Twilio console. They must match byte for byte — the
              signature is computed over the full URL, so an extra trailing slash rejects every
              request.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {WEBHOOK_LABELS.map(({ key, label, where }) => (
              <CopyRow key={key} label={label} value={urls[key]} hint={where} />
            ))}

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button
                variant="outline"
                onClick={() => void handleRotate()}
                disabled={rotating}
                className="gap-2"
              >
                {rotating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Rotate webhook token
              </Button>
              <p className="text-xs text-muted-foreground">
                Every URL above changes. Inbound calls and messages break until you paste the new
                ones into Twilio.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Compliance</CardTitle>
          <CardDescription className="text-muted-foreground">
            These registrations block traffic until they are approved. Start them early — the US one
            can take weeks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">US / Canada — A2P 10DLC</span>
              <Badge variant={messagingServiceSid ? 'secondary' : 'outline'}>
                {messagingServiceSid ? 'Messaging Service set' : 'not started'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Brand + Campaign registered with TCR and linked to a Messaging Service. 13–20 business
              days. Missing it returns error 30034 on every message.
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">Spain / Mexico / LATAM — Regulatory Bundle</span>
              <Badge variant={bundleSid ? 'secondary' : 'outline'}>
                {bundleSid ? 'bundle set' : 'not started'}
              </Badge>
            </div>
            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              <Input
                placeholder="Bundle SID (BUxxxx)"
                value={bundleSid}
                onChange={(e) => setBundleSid(e.target.value)}
                className="bg-muted border-border font-mono text-xs"
              />
              <Input
                placeholder="Address SID (ADxxxx)"
                value={addressSid}
                onChange={(e) => setAddressSid(e.target.value)}
                className="bg-muted border-border font-mono text-xs"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Buying a number without them returns 21649 / 21650. Create them in Twilio Console ›
              Phone Numbers › Regulatory Compliance.
            </p>
          </div>

          <div className="space-y-1">
            <span className="font-medium text-foreground">Voice (US) — STIR/SHAKEN</span>
            <p className="text-xs text-muted-foreground">
              Handled by Twilio automatically. Nothing to do here.
            </p>
          </div>

          <a
            href="https://console.twilio.com/us1/develop/sms/regulatory-compliance"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80"
          >
            <ExternalLink className="size-3.5" />
            Open Twilio Console
          </a>
        </CardContent>
      </Card>

      <div>
        <Button onClick={() => void handleSave()} disabled={saving} className="gap-2">
          {saving && <Loader2 className="size-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save Twilio configuration'}
        </Button>
      </div>
    </div>
  );
}
