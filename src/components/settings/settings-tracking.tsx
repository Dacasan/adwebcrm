'use client';

// ============================================================
// settings-tracking.tsx — vista de Tracking en Settings (§8).
//
// Es TRES cosas (§8.0), en este orden:
//   1. Un REGISTRO donde pegar los identificadores de medición.
//   2. Un DIAGNÓSTICO de qué eventos se registran y cuáles se entregan.
//   3. Unas NOTAS derivadas de datos reales (tracking-diagnostics.ts).
//
// NO es un interruptor: pegar un ID aquí lo GUARDA, no lo activa (§8.6 —
// la tabla de conexiones se pinta en la vista con todas las letras).
//
// Datos: la config viene del GET owner-only (/api/tracking/config); los
// eventos y entregas se consultan DIRECTO desde el navegador con RLS
// viewer+ (§8.1.1-1), mismo patrón que settings-overview.tsx. Los
// diagnósticos se CALCULAN en el cliente (§8.5) — ninguna frase fija.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SettingsChip, StatusDot } from '@/components/settings/settings-chip';
import {
  computeTrackingDiagnostics,
  type ConversionQueueRow,
  type Diagnostic,
  type TrackingEventRow,
} from '@/lib/analytics/tracking-diagnostics';

const EVENT_LIMIT = 2000;
const QUEUE_LIMIT = 2000;

interface TrackingConfigResponse {
  configured: boolean;
  meta_pixel_id: string | null;
  meta_dataset_id: string | null;
  has_meta_access_token: boolean;
  meta_test_event_code: string | null;
  gtm_container_id: string | null;
  ga4_measurement_id: string | null;
  google_ads_conversion_id: string | null;
  google_ads_conversion_label: string | null;
  hotjar_site_id: string | null;
  capi_env_present: boolean;
  google_ads_env_present: boolean;
}

interface FormState {
  meta_pixel_id: string;
  meta_dataset_id: string;
  meta_test_event_code: string;
  gtm_container_id: string;
  ga4_measurement_id: string;
  google_ads_conversion_id: string;
  google_ads_conversion_label: string;
  hotjar_site_id: string;
  meta_access_token: string; // solo se ENVÍA si el usuario escribe algo
}

const EMPTY_FORM: FormState = {
  meta_pixel_id: '',
  meta_dataset_id: '',
  meta_test_event_code: '',
  gtm_container_id: '',
  ga4_measurement_id: '',
  google_ads_conversion_id: '',
  google_ads_conversion_label: '',
  hotjar_site_id: '',
  meta_access_token: '',
};

/** La tabla §8.6: quién consume cada valor y si se activa al pegarlo. */
const CONNECTION_ROWS: { key: string; consumer: 'astro-site' | 'crm-server' }[] = [
  { key: 'meta_pixel_id', consumer: 'astro-site' },
  { key: 'meta_dataset_id', consumer: 'crm-server' },
  { key: 'meta_access_token', consumer: 'crm-server' },
  { key: 'meta_test_event_code', consumer: 'crm-server' },
  { key: 'gtm_container_id', consumer: 'astro-site' },
  { key: 'ga4_measurement_id', consumer: 'astro-site' },
  { key: 'google_ads_conversion', consumer: 'astro-site' },
  { key: 'hotjar_site_id', consumer: 'astro-site' },
];

export function TrackingSettings() {
  const t = useTranslations('Settings.tracking');
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [flags, setFlags] = useState<{
    capi_env_present: boolean;
    google_ads_env_present: boolean;
    has_meta_access_token: boolean;
  }>({ capi_env_present: false, google_ads_env_present: false, has_meta_access_token: false });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [events, setEvents] = useState<TrackingEventRow[]>([]);
  const [queue, setQueue] = useState<ConversionQueueRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  // Timestamp de la carga — capturado en load(), nunca durante el render
  // (Date.now() es impuro: el linter de hooks lo prohibe en render).
  const [loadedAtMs, setLoadedAtMs] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 1) Config (owner-only) + banderas que solo el servidor sabe.
      const res = await fetch('/api/tracking/config');
      if (res.ok) {
        const cfg = (await res.json()) as TrackingConfigResponse;
        setFlags({
          capi_env_present: cfg.capi_env_present,
          google_ads_env_present: cfg.google_ads_env_present,
          has_meta_access_token: cfg.has_meta_access_token,
        });
        setForm({
          meta_pixel_id: cfg.meta_pixel_id ?? '',
          meta_dataset_id: cfg.meta_dataset_id ?? '',
          meta_test_event_code: cfg.meta_test_event_code ?? '',
          gtm_container_id: cfg.gtm_container_id ?? '',
          ga4_measurement_id: cfg.ga4_measurement_id ?? '',
          google_ads_conversion_id: cfg.google_ads_conversion_id ?? '',
          google_ads_conversion_label: cfg.google_ads_conversion_label ?? '',
          hotjar_site_id: cfg.hotjar_site_id ?? '',
          meta_access_token: '',
        });
      }

      // 2) Eventos registrados (últimos 30 días) — RLS viewer+.
      const hace30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const [eventsRes, queueRes] = await Promise.all([
        supabase
          .from('tracking_events')
          .select('event_type, created_at, attribution, ip')
          .gte('created_at', hace30d)
          .order('created_at', { ascending: false })
          .limit(EVENT_LIMIT),
        // EL FILTRO channel='conversion' NO ES OPCIONAL (§8.9-1): sin él se
        // contarían los envíos de WhatsApp/SMS/email como conversiones.
        supabase
          .from('message_queue')
          .select('status, payload, last_error, due_at')
          .eq('channel', 'conversion')
          .gte('queued_at', hace30d)
          .limit(QUEUE_LIMIT),
      ]);
      setEvents((eventsRes.data ?? []) as unknown as TrackingEventRow[]);
      setQueue((queueRes.data ?? []) as unknown as ConversionQueueRow[]);
      setTruncated(
        (eventsRes.data?.length ?? 0) >= EVENT_LIMIT ||
          (queueRes.data?.length ?? 0) >= QUEUE_LIMIT
      );
      setLoadedAtMs(Date.now());
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const diagnostics: Diagnostic[] = useMemo(() => {
    if (loading) return [];
    return computeTrackingDiagnostics(events, queue, {
      capi_env_present: flags.capi_env_present,
      google_ads_env_present: flags.google_ads_env_present,
      saved: {
        meta_dataset_id: form.meta_dataset_id || null,
        meta_access_token_saved: flags.has_meta_access_token,
        gtm_container_id: form.gtm_container_id || null,
        ga4_measurement_id: form.ga4_measurement_id || null,
        google_ads_conversion_id: form.google_ads_conversion_id || null,
        google_ads_conversion_label: form.google_ads_conversion_label || null,
        hotjar_site_id: form.hotjar_site_id || null,
      },
    }, loadedAtMs, truncated);
  }, [loading, events, queue, flags, form, truncated, loadedAtMs]);

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = {
        meta_pixel_id: form.meta_pixel_id,
        meta_dataset_id: form.meta_dataset_id,
        meta_test_event_code: form.meta_test_event_code,
        gtm_container_id: form.gtm_container_id,
        ga4_measurement_id: form.ga4_measurement_id,
        google_ads_conversion_id: form.google_ads_conversion_id,
        google_ads_conversion_label: form.google_ads_conversion_label,
        hotjar_site_id: form.hotjar_site_id,
      };
      // §8.9-4: el token SOLO se envía si el usuario escribió uno — un
      // guardado de otro campo no lo toca.
      if (form.meta_access_token.trim()) {
        body.meta_access_token = form.meta_access_token.trim();
      }
      const res = await fetch('/api/tracking/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? res.statusText);
      }
      toast.success(t('saved'));
      setForm((f) => ({ ...f, meta_access_token: '' }));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const eventCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [events]);

  const deliveryCounts = useMemo(() => {
    const counts: Record<string, Record<string, number>> = {};
    for (const q of queue) {
      const platform = q.payload?.platform ?? 'unknown';
      counts[platform] ??= {};
      counts[platform][q.status] = (counts[platform][q.status] ?? 0) + 1;
    }
    return counts;
  }, [queue]);

  return (
    <div className="space-y-6">
      {/* §8.0 — no es un interruptor. Se pinta con todas las letras. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('title')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('intro')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
            <StatusDot tone="muted" />
            <p>{t('notSwitchWarning')}</p>
          </div>
        </CardContent>
      </Card>

      {/* Registro de identificadores */}
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('formTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('formHint')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['meta_pixel_id', 'metaPixelIdPlaceholder', false],
                ['meta_dataset_id', 'metaDatasetIdPlaceholder', false],
                ['meta_test_event_code', 'testEventCodePlaceholder', false],
                ['gtm_container_id', 'gtmPlaceholder', false],
                ['ga4_measurement_id', 'ga4Placeholder', false],
                ['google_ads_conversion_id', 'googleAdsIdPlaceholder', false],
                ['google_ads_conversion_label', 'googleAdsLabelPlaceholder', false],
                ['hotjar_site_id', 'hotjarPlaceholder', false],
              ] as const
            ).map(([key, placeholder]) => (
              <div key={key}>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t(`fields.${key}`)}
                </label>
                <Input
                  value={form[key]}
                  onChange={set(key)}
                  placeholder={t(placeholder)}
                  className="bg-muted text-foreground"
                />
              </div>
            ))}
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('fields.meta_access_token')}{' '}
                {flags.has_meta_access_token && (
                  <SettingsChip variant="ok">{t('tokenSaved')}</SettingsChip>
                )}
              </label>
              <Input
                type="password"
                value={form.meta_access_token}
                onChange={set('meta_access_token')}
                placeholder={t('tokenPlaceholder')}
                className="bg-muted text-foreground"
                autoComplete="off"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">{t('tokenHint')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? t('saving') : t('save')}
            </Button>
          </div>

          {/* §8.6 — la tabla de conexiones, pinta en la vista. */}
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t('connections.valueColumn')}</th>
                  <th className="px-3 py-2">{t('connections.consumerColumn')}</th>
                  <th className="px-3 py-2">{t('connections.activeColumn')}</th>
                </tr>
              </thead>
              <tbody>
                {CONNECTION_ROWS.map((row) => (
                  <tr key={row.key} className="border-t border-border">
                    <td className="px-3 py-2 font-medium text-foreground">
                      {t(`connections.rows.${row.key}`)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {t(`connections.consumers.${row.consumer}`)}
                    </td>
                    <td className="px-3 py-2">
                      <SettingsChip variant="muted">{t('connections.notActive')}</SettingsChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t('envNote')}</p>
        </CardContent>
      </Card>

      {/* Diagnóstico — eventos, entregas, notas */}
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('diagnosticsTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('diagnosticsHint')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {truncated && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
              <StatusDot tone="muted" />
              <p>{t('truncated')}</p>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <h3 className="mb-2 text-sm font-semibold text-foreground">
                {t('eventsTitle')}
              </h3>
              {eventCounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noData')}</p>
              ) : (
                <ul className="space-y-1 text-sm text-foreground">
                  {eventCounts.map(([type, count]) => (
                    <li key={type} className="flex justify-between">
                      <span>{type}</span>
                      <span className="text-muted-foreground">{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-md border border-border p-3">
              <h3 className="mb-2 text-sm font-semibold text-foreground">
                {t('deliveriesTitle')}
              </h3>
              {Object.keys(deliveryCounts).length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noData')}</p>
              ) : (
                <ul className="space-y-1 text-sm text-foreground">
                  {Object.entries(deliveryCounts).map(([platform, statuses]) => (
                    <li key={platform}>
                      <div className="font-medium">{platform}</div>
                      <div className="text-muted-foreground">
                        {Object.entries(statuses)
                          .map(([status, count]) => `${status}: ${count}`)
                          .join(' · ')}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{t('notesTitle')}</h3>
            {diagnostics.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noIssues')}</p>
            ) : (
              <ul className="space-y-2">
                {diagnostics.map((d, i) => (
                  <li
                    key={`${d.code}-${i}`}
                    className="flex items-start gap-2 rounded-md border border-border p-3 text-sm"
                  >
                    <StatusDot tone="muted" />
                    <div>
                      <div className="flex items-center gap-2">
                        <SettingsChip variant={d.level === 'error' ? 'warn' : 'muted'}>
                          {t(`levels.${d.level}`)}
                        </SettingsChip>
                        <span className="font-medium text-foreground">
                          {t(`diagnostics.${d.code}`, d.detail as Record<string, never>)}
                        </span>
                      </div>
                      <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                        {JSON.stringify(d.detail)}
                      </pre>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
