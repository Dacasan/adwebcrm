'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronRight,
  LayoutTemplate,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { THEMES } from '@/lib/themes';
import { CURRENCIES } from '@/lib/currency';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { SECTION_META, type SettingsSection } from './settings-sections';
import { SettingsChip, StatusDot } from './settings-chip';
import { ROLE_META } from './role-meta';

interface OverviewCounts {
  members: number | null;
  pendingInvites: number | null;
  templates: number | null;
  templatesPending: number | null;
  emailTemplates: number | null;
  tags: number | null;
  customFields: number | null;
}

interface WhatsAppStatus {
  configured: boolean;
  connected: boolean;
}

/** Estado de un canal (voz/SMS/email): proveedor activo + credenciales presentes. */
interface ChannelStatus {
  provider: string;
  configured: boolean;
}

export function SettingsOverview({
  onSelect,
}: {
  onSelect: (section: SettingsSection) => void;
}) {
  const { user, profile, accountId, accountRole, defaultCurrency, canManageMembers } =
    useAuth();
  const { mode, theme } = useTheme();
  const t = useTranslations('Settings.overview');
  const tRoles = useTranslations('Settings.roles');
  const tSections = useTranslations('Settings.sections');

  const [counts, setCounts] = useState<OverviewCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  // WhatsApp status is tracked separately: its health check decrypts the
  // token and pings Meta, which is far slower than the cheap count
  // queries. Gating it independently keeps a slow/flaky Meta round-trip
  // from blanking the rest of the landing.
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(true);
  const [channels, setChannels] = useState<{
    voice: ChannelStatus;
    sms: ChannelStatus;
    email: ChannelStatus;
  } | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    if (!user || !accountId) return;
    let cancelled = false;
    const supabase = createClient();
    const userId = user.id;
    const acctId = accountId;

    // Cheap counts — resolve fast, render immediately.
    (async () => {
      setCountsLoading(true);
      const [membersRes, invitesRes, templatesTotal, templatesPending, tagsRes, fieldsRes, emailTemplatesRes] =
        await Promise.allSettled([
          fetch('/api/account/members', { cache: 'no-store' }).then((r) => r.json()),
          canManageMembers
            ? fetch('/api/account/invitations', { cache: 'no-store' }).then((r) =>
                r.json(),
              )
            : Promise.resolve(null),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'PENDING'),
          supabase
            .from('tags')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase.from('custom_fields').select('id', { count: 'exact', head: true }),
          // Plantillas de EMAIL (funnel en email_templates) — distinta tabla
          // que message_templates (WhatsApp).
          supabase.from('email_templates').select('id', { count: 'exact', head: true }),
        ]);

      if (cancelled) return;

      const members =
        membersRes.status === 'fulfilled' && Array.isArray(membersRes.value?.members)
          ? membersRes.value.members.length
          : null;
      const pendingInvites =
        invitesRes.status === 'fulfilled' &&
        invitesRes.value &&
        Array.isArray(invitesRes.value.invitations)
          ? invitesRes.value.invitations.length
          : null;

      setCounts({
        members,
        pendingInvites,
        templates:
          templatesTotal.status === 'fulfilled'
            ? templatesTotal.value.count ?? null
            : null,
        templatesPending:
          templatesPending.status === 'fulfilled'
            ? templatesPending.value.count ?? null
            : null,
        tags: tagsRes.status === 'fulfilled' ? tagsRes.value.count ?? null : null,
        customFields:
          fieldsRes.status === 'fulfilled' ? fieldsRes.value.count ?? null : null,
        emailTemplates:
          emailTemplatesRes.status === 'fulfilled'
            ? emailTemplatesRes.value.count ?? null
            : null,
      });
      setCountsLoading(false);
    })();

    // WhatsApp connection status — slower, independent.
    (async () => {
      setWhatsappLoading(true);
      const [row, health] = await Promise.allSettled([
        supabase
          .from('whatsapp_config')
          .select('phone_number_id')
          .eq('account_id', acctId)
          .maybeSingle(),
        fetch('/api/whatsapp/config', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (cancelled) return;
      setWhatsapp({
        configured: row.status === 'fulfilled' && !!row.value.data?.phone_number_id,
        connected: health.status === 'fulfilled' && !!health.value?.connected,
      });
      setWhatsappLoading(false);
    })();

    // Estado de los otros canales: provider_routing dice QUÉ proveedor sirve
    // cada canal; las credenciales se verifican por fuente separada
    // (/api/twilio/config → {configured}; filas telnyx_config / email_config
    // legibles por el owner con RLS — mismo patrón que whatsapp_config).
    (async () => {
      setChannelsLoading(true);
      const [routing, twilioCfg, telnyxCfg, emailCfg] = await Promise.allSettled([
        fetch('/api/providers/routing', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/twilio/config', { cache: 'no-store' }).then((r) => r.json()),
        supabase.from('telnyx_config').select('id').maybeSingle(),
        supabase.from('email_config').select('id').maybeSingle(),
      ]);
      if (cancelled) return;
      const r = routing.status === 'fulfilled' ? routing.value : null;
      const twilioOk = twilioCfg.status === 'fulfilled' && !!twilioCfg.value?.configured;
      const telnyxOk = telnyxCfg.status === 'fulfilled' && !!telnyxCfg.value?.data?.id;
      const emailOk = emailCfg.status === 'fulfilled' && !!emailCfg.value?.data?.id;
      const pick = (provider: string | undefined): ChannelStatus => ({
        provider: provider ?? '—',
        configured:
          provider === 'twilio'
            ? twilioOk
            : provider === 'resend' || provider === 'sendgrid'
              ? emailOk
              : telnyxOk,
      });
      setChannels({
        voice: pick(r?.voice),
        sms: pick(r?.sms),
        email: pick(r?.email),
      });
      setChannelsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, accountId, canManageMembers]);

  const displayName = profile?.full_name || profile?.email || t('yourAccount');
  const initial = (profile?.full_name || profile?.email || 'U').charAt(0).toUpperCase();
  const roleMeta = accountRole ? ROLE_META[accountRole] : null;
  const RoleIcon = roleMeta?.icon;

  const currencyLabel =
    CURRENCIES.find((c) => c.code === defaultCurrency)?.label ?? defaultCurrency;
  const themeName = THEMES.find((t) => t.id === theme)?.name ?? theme;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // Per-tile loading + subtitle. `null` counts render as a graceful
  // fallback so a single failed query never blanks a tile.
  const channelSubtitle = (c: ChannelStatus | undefined): ReactNode =>
    !c ? (
      t('notSetup')
    ) : c.configured ? (
      <>
        <StatusDot tone="ok" /> {cap(c.provider)} · {t('connected')}
      </>
    ) : (
      <>
        <StatusDot tone="muted" /> {cap(c.provider)} · {t('notSetup')}
      </>
    );

  const tiles: {
    section?: SettingsSection;
    title?: string;
    href?: string;
    icon: LucideIcon;
    loading: boolean;
    subtitle: ReactNode;
  }[] = [
    {
      section: 'whatsapp',
      icon: SECTION_META.whatsapp.icon,
      loading: whatsappLoading,
      subtitle: !whatsapp?.configured ? (
        t('notSetup')
      ) : whatsapp.connected ? (
        <>
          <StatusDot tone="ok" /> {t('connected')}
        </>
      ) : (
        <>
          <StatusDot tone="muted" /> {t('needsReconnecting')}
        </>
      ),
    },
    {
      title: 'Calls',
      href: '/calls?tab=setup',
      icon: Phone,
      loading: channelsLoading,
      subtitle: channelSubtitle(channels?.voice),
    },
    {
      title: 'Messages (SMS)',
      href: '/calls?tab=setup',
      icon: MessageSquare,
      loading: channelsLoading,
      subtitle: channelSubtitle(channels?.sms),
    },
    {
      title: 'Email',
      href: '/email?tab=setup',
      icon: Mail,
      loading: channelsLoading,
      subtitle: channelSubtitle(channels?.email),
    },
    {
      title: 'Email templates',
      href: '/email',
      icon: LayoutTemplate,
      loading: countsLoading,
      subtitle:
        counts?.emailTemplates == null
          ? t('notSetup')
          : t('templatesCount', { count: counts.emailTemplates }),
    },
    {
      section: 'members',
      icon: SECTION_META.members.icon,
      loading: countsLoading,
      subtitle:
        counts?.members == null
          ? t('viewTeamMembers')
          : `${t('membersCount', { count: counts.members })}${
              counts.pendingInvites
                ? ` · ${t('pendingInvites', { count: counts.pendingInvites })}`
                : ''
            }`,
    },
    {
      section: 'templates',
      icon: SECTION_META.templates.icon,
      loading: countsLoading,
      subtitle:
        counts?.templates == null
          ? t('manageTemplates')
          : `${t('templatesCount', { count: counts.templates })}${
              counts.templatesPending
                ? ` · ${t('pendingReview', { count: counts.templatesPending })}`
                : ''
            }`,
    },
    {
      section: 'deals',
      icon: SECTION_META.deals.icon,
      loading: false,
      subtitle: `${defaultCurrency} — ${currencyLabel}`,
    },
    {
      section: 'fields',
      icon: SECTION_META.fields.icon,
      loading: countsLoading,
      subtitle:
        counts?.tags == null && counts?.customFields == null
          ? t('tagsAndFields')
          : `${t('tagsCount', { count: counts?.tags ?? 0 })} · ${t('fieldsCount', {
              count: counts?.customFields ?? 0,
            })}`,
    },
    {
      section: 'appearance',
      icon: SECTION_META.appearance.icon,
      loading: false,
      subtitle: t('appearance', { mode: cap(mode), theme: themeName }),
    },
  ];

  return (
    <section className="animate-in fade-in-50 duration-200">
      {/* Identity */}
      <Card className="flex-row items-center gap-4 px-5 py-5">
        <Avatar size="lg" className="size-14">
          {profile?.avatar_url ? (
            <AvatarImage src={profile.avatar_url} alt={displayName} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-xl text-primary">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-foreground">
            {displayName}
          </div>
          {profile?.email ? (
            <div className="truncate text-sm text-muted-foreground">
              {profile.email}
            </div>
          ) : null}
        </div>
        {roleMeta && RoleIcon ? (
          <SettingsChip variant={roleMeta.variant}>
            <RoleIcon />
            {tRoles(accountRole!)}
          </SettingsChip>
        ) : null}
      </Card>

      {/* Status tiles */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <button
              key={tile.title ?? tile.section}
              type="button"
              onClick={() =>
                tile.href ? router.push(tile.href) : tile.section && onSelect(tile.section)
              }
              className={cn(
                'group flex items-start gap-3.5 rounded-xl border border-border bg-card p-4 text-left transition-colors',
                'hover:border-primary-soft-2 hover:bg-card-2',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">
                  {tile.title ?? (tile.section ? tSections(tile.section) : '')}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {tile.loading ? (
                    <>
                      <Loader2 className="size-3 animate-spin" /> {t('loading')}
                    </>
                  ) : (
                    tile.subtitle
                  )}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
