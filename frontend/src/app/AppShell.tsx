import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { Button, useTheme } from 'react-design-kit';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import styles from './AppShell.module.css';

const navItems = [
  { to: '/devices', label: 'Devices', icon: icons.device },
  { to: '/builds', label: 'Builds', icon: icons.build },
  { to: '/execution', label: 'Execution', icon: icons.execution },
  { to: '/analytics', label: 'Analytics', icon: icons.analytics },
  { to: '/hosts', label: 'Hosts', icon: icons.host },
];

// Every other nav item is a public read gated only on its actions — this one
// is different because the backend gates the *read itself* (GET
// /api/agent-credentials is admin-only, unlike /devices or /hosts), so
// showing the link to anyone else would just point at a page that can never
// load anything for them.
const adminNavItems = [{ to: '/agent-credentials', label: 'Agent tokens', icon: icons.credential }];

function UserMenu() {
  const { user, isLoading, logout } = useAuth();
  const location = useLocation();

  if (isLoading) return <span className={styles.userSkeleton} aria-hidden="true" />;

  if (!user) {
    return (
      <Link to="/login" state={{ from: location.pathname }}>
        <Button size="sm" variant="secondary">
          Sign in
        </Button>
      </Link>
    );
  }

  return (
    <div className={styles.user}>
      <span className={styles.userInfo}>
        <span className={styles.userName}>{user.name}</span>
        <span className={styles.userRole}>{user.role}</span>
      </span>
      <Button size="sm" variant="ghost" onClick={logout}>
        Sign out
      </Button>
    </div>
  );
}

export function AppShell() {
  // The storage key is passed explicitly rather than taking the kit's generic
  // default: `mh_theme` is what mobile-hub has always written, so anyone with
  // a saved preference keeps it.
  const { theme, toggle } = useTheme({ storageKey: 'mh_theme', defaultTheme: 'dark' });
  const ThemeIcon = theme === 'dark' ? icons.themeLight : icons.themeDark;
  const { can } = useAuth();
  const visibleNavItems = can('admin') ? [...navItems, ...adminNavItems] : navItems;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <NavLink to="/" className={styles.logo} aria-label="Mobile Hub home">
          <BrandLogo />
        </NavLink>

        <nav className={styles.nav} aria-label="Main">
          {visibleNavItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}
            >
              <Icon className={styles.navIcon} size={iconSize.dense} aria-hidden="true" />
              <span className={styles.navLabel}>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className={styles.right}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={toggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            <ThemeIcon size={iconSize.control} aria-hidden="true" />
          </Button>
          <UserMenu />
        </div>
      </header>

      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
