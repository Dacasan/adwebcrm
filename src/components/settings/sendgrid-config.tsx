'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
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
import { Textarea } from '@/components/ui/textarea';

// ============================================================
// SendGrid config (email). owner-only (RLS).
//
// La pieza que no es opcional: el ESTADO DE AUTENTICACIÓN DE DOMINIO. Un
// `from_email` en un dominio sin DKIM firmado va a spam SIN devolver
// error, así que si no se enseña aquí el usuario lo descubre cuando
// nadie abre su campaña. Con el dominio sin autenticar, el envío de
// CAMPAÑAS se bloquea en el servidor; el transaccional sigue saliendo.
// ============================================================

const MASKED = '••••••••••••••••••••';

interface SendGridConfigResponse {
  configured: boolean;
  has_api_key?: boolean;
  from_email?: string;
  from_name?: string | null;
  reply_to?: string | null;
  has_webhook_public_key?: boolean;
  /** null cuando falta la base pública en el servidor. */
  webhook_url?: string | null;
  domain_authenticated?: boolean;
  domain_checked_at?: string | null;
}

export function SendGridConfig() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [config, setConfig] = useState<SendGridConfigResponse | null>(null);

  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [publicKey, setPublicKey] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sendgrid/config');
      if (!res.ok) {
        setConfig(null);
        return;
      }
      const data = (await res.json()) as SendGridConfigResponse;
      setConfig(data);
      setApiKey(data.configured ? MASKED : '');
      setKeyEdited(false);
      setFromEmail(data.from_email ?? '');
      setFromName(data.from_name ?? '');
      setReplyTo(data.reply_to ?? '');
      setPublicKey('');
    } catch {
      toast.error('Failed to load SendGrid configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(extra: Record<string, unknown> = {}) {
    const payload: Record<string, unknown> = {
      from_email: fromEmail.trim(),
      from_name: fromName.trim(),
      reply_to: replyTo.trim(),
      ...extra,
    };
    if (keyEdited && apiKey.trim() && apiKey !== MASKED) payload.api_key = apiKey.trim();
    if (publicKey.trim()) payload.webhook_public_key = publicKey.trim();

    const res = await fetch('/api/sendgrid/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || 'Could not save SendGrid configuration');
      return false;
    }
    await load();
    return true;
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (await save()) toast.success('SendGrid configuration saved');
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate() {
    setRotating(true);
    try {
      if (await save({ rotate_webhook_token: true })) {
        toast.success('Webhook token rotated — paste the new URL in SendGrid');
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
  const domainOk = config?.domain_authenticated === true;

  return (
    <div className="space-y-6">
      <Alert className="bg-card border-border">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-primary" />
          <AlertTitle className="text-foreground mb-0">
            {configured ? 'SendGrid connected' : 'SendGrid not configured'}
          </AlertTitle>
        </div>
        <AlertDescription className="text-muted-foreground">
          Bring your own SendGrid account. The API key is stored encrypted and never sent back to
          the browser.
        </AlertDescription>
      </Alert>

      {configured && (
        <Alert
          className={
            domainOk ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'
          }
        >
          <div className="flex items-center gap-2">
            {domainOk ? (
              <CheckCircle2 className="size-4 text-emerald-600" />
            ) : (
              <AlertTriangle className="size-4 text-amber-600" />
            )}
            <AlertTitle className="mb-0 text-foreground">
              {domainOk ? 'Sender domain authenticated' : 'Sender domain NOT authenticated'}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {domainOk
              ? 'DKIM/SPF are signed for this domain. Campaigns can go out.'
              : 'Unauthenticated mail lands in spam without returning any error, and a thousand messages in spam burn the domain reputation for good. Campaign sending is blocked until this is fixed; transactional email still goes out.'}
            {config?.domain_checked_at && (
              <span className="block pt-1 text-xs">
                Last checked {new Date(config.domain_checked_at).toLocaleString()} — re-save to
                re-check.
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Credentials</CardTitle>
          <CardDescription className="text-muted-foreground">
            From SendGrid › Settings › API Keys. Needs Mail Send permission, plus read access to
            Sender Authentication so the domain check works.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">API key</Label>
            <div className="relative">
              <Input
                type={showKey ? 'text' : 'password'}
                placeholder="SG.xxxxxxxx"
                value={apiKey}
                onFocus={() => {
                  if (apiKey === MASKED) {
                    setApiKey('');
                    setKeyEdited(true);
                  }
                }}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeyEdited(true);
                }}
                className="bg-muted border-border pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">From email</Label>
              <Input
                placeholder="hola@tudominio.com"
                value={fromEmail}
                onChange={(e) => setFromEmail(e.target.value)}
                className="bg-muted border-border"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">From name</Label>
              <Input
                placeholder="Clínica Ejemplo"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                className="bg-muted border-border"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Reply-to</Label>
            <Input
              placeholder="citas@tudominio.com"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              className="bg-muted border-border"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Event webhook</CardTitle>
          <CardDescription className="text-muted-foreground">
            Turn on the Signed Event Webhook in SendGrid › Settings › Mail Settings, paste its
            public key here, and point it at the URL below. Without the public key this endpoint
            rejects everything with a 503 — on purpose.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {config?.webhook_url && (
            <div className="space-y-1">
              <Label className="text-muted-foreground">Webhook URL</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={config.webhook_url}
                  className="bg-muted border-border text-muted-foreground font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => {
                    navigator.clipboard.writeText(config.webhook_url ?? '');
                    toast.success('Copied');
                  }}
                  aria-label="Copy webhook URL"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-muted-foreground">
              Verification public key{' '}
              <Badge variant={config?.has_webhook_public_key ? 'secondary' : 'outline'}>
                {config?.has_webhook_public_key ? 'set' : 'missing'}
              </Badge>
            </Label>
            <Textarea
              placeholder="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              rows={3}
              className="bg-muted border-border font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Base64, as SendGrid shows it. Leave empty to keep the current one.
            </p>
          </div>

          {configured && (
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
                The URL changes. Delivery and open tracking stop until you paste the new one into
                SendGrid.
              </p>
            </div>
          )}

          <a
            href="https://app.sendgrid.com/settings/sender_auth"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80"
          >
            <ExternalLink className="size-3.5" />
            Open SendGrid Sender Authentication
          </a>
        </CardContent>
      </Card>

      <div>
        <Button onClick={() => void handleSave()} disabled={saving} className="gap-2">
          {saving && <Loader2 className="size-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save SendGrid configuration'}
        </Button>
      </div>
    </div>
  );
}
