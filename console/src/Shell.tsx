import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from './app-context';
import { formatTime, initials } from './lib';
import { VIEW_TITLES, navigate, type Route, type View } from './router';
import './shell.css';

interface NavEntry { nav: string; view: View; href: string; label: string; icon: string; tag?: string }
interface NavGroup { title: string | null; tag?: string; items: NavEntry[] }

const GROUPS: NavGroup[] = [
  { title: null, items: [
    { nav: 'overview', view: 'dashboard', href: '#overview', label: 'Overview', icon: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z' },
    { nav: 'runs', view: 'runs', href: '#runs', label: 'Runs', icon: 'M3 12h4l2.5-6 5 12 2.5-6h4' },
    { nav: 'qa', view: 'qa', href: '#qa', label: 'QA', icon: 'M9 3h6M10 3v5.5L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9.5V3M8 14h8' },
    { nav: 'explorer', view: 'explorer', href: '#tests', label: 'Tests', tag: 'Local', icon: 'M10 6h10M10 12h10M10 18h10M4 6l1.2 1.2L7.5 5M4 12l1.2 1.2 2.3-2.2M4 18l1.2 1.2 2.3-2.2' },
    { nav: 'analytics', view: 'analytics', href: '#analytics', label: 'Analytics', icon: 'M5 20V11M12 20V5M19 20v-8M3 20h18' },
  ] },
  { title: 'Build', items: [
    { nav: 'recorder', view: 'recorder', href: '#recorder', label: 'Recorder', tag: 'Local', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z' },
    { nav: 'healing', view: 'healing', href: '#healing', label: 'Self-healing', tag: 'Local', icon: 'M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM12 2v3M12 19v3M2 12h3M19 12h3M12 10.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z' },
    { nav: 'checkpoints', view: 'checkpoints', href: '#checkpoints', label: 'Checkpoints', tag: 'Local', icon: 'M6 3.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM6 15.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM18 6.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM6 8.5v7M18 11.5c0 3.5-3.5 4.5-9.5 5.5' },
  ] },
  { title: 'Protect', items: [
    { nav: 'policy', view: 'policy', href: '#policy', label: 'Request policy', tag: 'Local', icon: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5c-4.3-1.3-7.5-4.9-7.5-9.5V6z' },
    { nav: 'audit', view: 'audit', href: '#evidence', label: 'Evidence', icon: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3' },
  ] },
  { title: 'Lab', tag: 'Preview', items: [
    { nav: 'timewarp', view: 'timewarp', href: '#timewarp', label: 'Time warp', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM12 7.5V12l3 2' },
    { nav: 'fixtures', view: 'fixtures', href: '#fixtures', label: 'Fixtures', icon: 'M4.5 6c0-1.7 3.4-3 7.5-3s7.5 1.3 7.5 3s-3.4 3-7.5 3s-7.5-1.3-7.5-3zM4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6' },
    { nav: 'chaos', view: 'chaos', href: '#chaos', label: 'Chaos report', icon: 'M13 3L5 13.5h6l-1 7.5 8-10.5h-6z' },
    { nav: 'capsules', view: 'capsules', href: '#capsules', label: 'Bug capsules', icon: 'M5.17 13.17L13.17 5.17A4 4 0 0 1 18.83 10.83L10.83 18.83A4 4 0 0 1 5.17 13.17zM9.17 9.17l5.66 5.66' },
  ] },
  { title: 'Setup', items: [
    { nav: 'integrations', view: 'integrations', href: '#cicd', label: 'CI/CD & API', icon: 'M6 3.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM6 8.5v12M18 15.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM18 15.5V9a2 2 0 0 0-2-2h-4M14 4.5L11.5 7 14 9.5' },
    { nav: 'settings', view: 'settings', href: '#settings', label: 'Settings', icon: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4' },
  ] },
];

function Icon({ d, size = 18, width = 1.9 }: { d: string; size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function BrandMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="18" fill="#2F6F5B" />
      <path d="M16 48V31.5C16 22.94 22.94 16 31.5 16h1C41.06 16 48 22.94 48 31.5V48" fill="none" stroke="#F7FBF8" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M23.5 47V31.5a8.5 8.5 0 0 1 17 0V47" fill="none" stroke="#B8E4CE" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M32 31v13" fill="none" stroke="#F7FBF8" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M19.5 49.5h25" fill="none" stroke="#F7FBF8" strokeWidth="4.5" strokeLinecap="round" />
      <circle cx="44.5" cy="20.5" r="2.2" fill="#B8E4CE" />
    </svg>
  );
}

function cap(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Collapsing menu below 861px: the sidebar shows the brand and a Menu button until it is opened. */
function useNarrowMenu() {
  const [open, setOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 860px)');
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && asideRef.current?.getAttribute('data-open') === 'true') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onChange = () => { if (!narrow.matches) setOpen(false); };
    document.addEventListener('keydown', onKey);
    narrow.addEventListener('change', onChange);
    return () => {
      document.removeEventListener('keydown', onKey);
      narrow.removeEventListener('change', onChange);
    };
  }, []);
  // Choosing a destination closes the menu so the page shows.
  const onAsideClick = useCallback((event: React.MouseEvent) => {
    const link = (event.target as Element).closest('a[href]');
    if (link && window.matchMedia('(max-width: 860px)').matches) setOpen(false);
  }, []);
  return { open, setOpen, asideRef, toggleRef, onAsideClick };
}

export function Sidebar({ route }: { route: Route }) {
  const app = useApp();
  const live = app.mode === 'live';
  const menu = useNarrowMenu();
  const user = app.me?.user;
  const workspace = app.me?.workspace;
  const plan = workspace?.plan ? cap(workspace.plan) : 'Free';
  const workspaceName = live ? workspace?.name || 'Workspace' : 'Acme workspace';
  const displayName = live ? user?.name || user?.email || 'Account' : 'Maya Chen';
  const role = live ? (user?.name ? user.email : `${plan} plan`) : 'Workspace admin';
  const usage = app.usage;
  const daily = usage?.daily;
  const percent = daily && daily.limit > 0 ? Math.min(100, Math.round((daily.used / daily.limit) * 100)) : live ? 0 : 64;
  const usageText = live
    ? (daily ? `${daily.used} / ${daily.limit}` : app.usageError ? 'Unavailable' : '…')
    : '64 / 100';
  const barColor = percent >= 100 ? 'rgb(180, 35, 24)' : percent >= 80 ? 'rgb(181, 106, 20)' : 'rgb(47, 111, 91)';
  const signOutLabel = live ? `Sign out ${user?.email || ''}`.trim() : 'Sign out of sample workspace';

  return (
    <aside ref={menu.asideRef} data-open={menu.open ? 'true' : undefined} onClick={menu.onAsideClick}>
      <nav className="primary-nav" id="console-nav" aria-label="Console">
        <a className="nav-brand" href="/" aria-label="AirlockQA home">
          <BrandMark />
          <span className="nav-brand-text">Airlock<span>QA</span></span>
        </a>
        <button type="button" id="nav-toggle" className="nav-toggle" ref={menu.toggleRef} aria-expanded={menu.open} aria-controls="console-nav" onClick={() => menu.setOpen(!menu.open)}>
          {menu.open ? 'Close' : 'Menu'}
        </button>
        <button
          type="button" id="ws-button" className="nav-workspace" disabled={live}
          aria-label={live ? `Workspace: ${workspaceName}, ${plan} plan` : `Switch workspace. Current: ${workspaceName}, Cloud plan`}
        >
          <span className="nav-workspace-mark">{initials(workspaceName).slice(0, 1)}</span>
          <span className="nav-workspace-text">
            <span className="nav-workspace-name" id="ws-name">{workspaceName}</span>
            <span className="nav-workspace-plan" id="ws-plan">{live ? `${plan} plan` : 'Cloud plan · 3 projects'}</span>
          </span>
          {live ? null : <Icon d="M8 9l4-4 4 4M16 15l-4 4-4-4" size={16} width={2} />}
        </button>
        <a className="nav-cta" id="side-cta" href={live ? '#runs/new' : '#recorder'} data-nav={live ? undefined : 'recorder'}>
          <Icon d="M12 5v14M5 12h14" size={17} width={2.2} />
          {live ? 'Start cloud run' : 'Record a test'}
        </a>
        <div className="nav-groups">
          {GROUPS.map((group, index) => (
            <div className="nav-group" key={index}>
              {group.title ? (
                <div className="nav-group-title"><span>{group.title}</span>{group.tag ? <span className="nav-group-tag">{group.tag}</span> : null}</div>
              ) : null}
              <div className="nav-items">
                {group.items.map((item) => {
                  const current = route.view === item.view;
                  const badge = item.nav === 'runs' && live;
                  return (
                    <a key={item.nav} className={'cn-item' + (current ? ' is-active' : '')} href={item.href} data-nav={item.nav} aria-current={current ? 'page' : undefined}>
                      <Icon d={item.icon} />
                      <span className="cn-label">{item.label}</span>
                      {item.tag ? <span className="cn-tag">{item.tag}</span> : null}
                      {badge ? (
                        <span className="cn-badge" hidden={app.activeRuns === 0} aria-label={`${app.activeRuns} active ${app.activeRuns === 1 ? 'run' : 'runs'}`}>{app.activeRuns}</span>
                      ) : null}
                      {!live && item.nav === 'runs' ? <span className="cn-badge">1</span> : null}
                      {!live && item.nav === 'healing' ? <span className="cn-badge">3</span> : null}
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="nav-foot">
          <div className="nav-usage">
            <div className="nav-usage-line"><span>Cloud runs today</span><span id="usage-count" className="nav-usage-count">{usageText}</span></div>
            <div
              className="nav-usage-track" id="usage-track" role="progressbar" aria-label="Cloud runs used today"
              aria-valuemin={0} aria-valuemax={daily ? daily.limit : 100} aria-valuenow={daily ? daily.used : live ? undefined : 64}
              aria-valuetext={daily ? `${daily.used} of ${daily.limit} runs used today` : undefined}
            >
              <span className="nav-usage-bar" id="usage-bar" style={{ width: `${percent}%`, background: barColor }} />
            </div>
            <span id="usage-reset" className="usage-reset" hidden={!daily}>{daily ? `Resets at ${formatTime(daily.resetAt)}` : ''}</span>
            <a className="nav-usage-link" href="#cicd" data-nav="integrations">Usage &amp; keys</a>
          </div>
          <a className="nav-docs" href="https://github.com/katesaikishore/AirlockQA/blob/main/docs/HOW-TO-USE.md" target="_blank" rel="noreferrer">
            <Icon d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19" />
            Docs &amp; guides
          </a>
          <div className="nav-profile">
            <span className="nav-profile-avatar" id="profile-avatar">{initials(displayName)}</span>
            <span className="nav-profile-text">
              <span className="nav-profile-name" id="profile-name">{displayName}</span>
              <span className="nav-profile-role" id="profile-role">{role}</span>
            </span>
            <button className="nav-signout profile-button" type="button" data-demo-signout aria-label={signOutLabel} onClick={() => void app.signOut()}>
              <Icon d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" size={16} width={2} />
            </button>
          </div>
        </div>
      </nav>
    </aside>
  );
}

export function Topbar({ route }: { route: Route }) {
  const app = useApp();
  const live = app.mode === 'live';
  const email = app.me?.user.email || '';
  const displayName = live ? app.me?.user.name || email || 'Account' : 'Maya Chen';
  const [draft, setDraft] = useState('');
  return (
    <header className="app-topbar">
      <nav className="topbar-crumb" aria-label="Breadcrumb">
        <span id="crumb-workspace">{live ? app.me?.workspace.name || 'Workspace' : 'Acme workspace'}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        <strong id="page-heading" aria-current="page">{VIEW_TITLES[route.view]}</strong>
      </nav>
      <label className="topbar-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
        <span className="sr-only">Search the workspace</span>
        <input
          id="global-search" type="search" placeholder={live ? 'Search runs…' : 'Search runs, tests, requests…'} value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !live) return;
            event.preventDefault();
            app.setSearch(draft);
            navigate('runs');
          }}
        />
        <kbd>⌘K</kbd>
      </label>
      <div className="topbar-actions">
        <button className="c-btn c-sec" id="open-run-search" type="button" aria-label={live ? 'Search runs' : 'Search sample runs'} onClick={() => { navigate('runs'); window.requestAnimationFrame(() => document.getElementById('run-search-full')?.focus()); }}>
          <span>⌕ Runs</span>
        </button>
        <button className="c-btn c-sec" id="open-audit" type="button" aria-label="Open audit and evidence" onClick={() => navigate('evidence')}>
          <span>♧ Evidence</span>
        </button>
        <span className="preview-chip" id="workspace-chip" title={live ? `Signed in as ${email}` : undefined}>
          <i className="chip-dot" />
          {live ? <span className="chip-text" id="signed-in-email">{email}</span> : <>Sample workspace <span>·</span> preview data</>}
        </span>
        <button className="topbar-avatar" id="topbar-avatar" type="button" data-demo-signout title="Sign out" aria-label={live ? `Sign out ${email}` : 'Sign out of sample workspace'} onClick={() => void app.signOut()}>
          {initials(displayName)}
        </button>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="app-footer">
      <span>© 2026 AirlockQA · Isolated browser test operations</span>
      <span><i /> API endpoint configured · <code>POST /v1/runs</code></span>
      <a href="https://github.com/katesaikishore/AirlockQA" target="_blank" rel="noreferrer">Documentation ↗</a>
    </footer>
  );
}

export function SampleBanner() {
  return (
    <div className="sample-banner" id="sample-banner" role="region" aria-label="Sample data notice">
      <strong>Sample data.</strong> Everything in this console is illustrative and does not come from your account. <a href="/login">Sign in</a> to see your real runs.
    </div>
  );
}

export function Panel({ view, children }: { view: View; children: ReactNode }) {
  return <section className="view-panel" id={'view-' + view} data-view-panel={view}>{children}</section>;
}
