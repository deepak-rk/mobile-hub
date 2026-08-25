import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { Button } from '@/components/ui/Button';
import { icons, iconSize } from '@/lib/icons';
import { useTheme } from '@/lib/theme';
import { useAuth } from '@/features/auth/useAuth';
import styles from './AppShell.module.css';

const navItems = [
  { to: '/devices', label: 'Devices', icon: icons.device },
  { to: '/builds', label: 'Builds', icon: icons.build },
  { to: '/execution', label: 'Execution', icon: icons.execution },
  { to: '/analytics', label: 'Analytics', icon: icons.analytics },
  { to: '/servers', label: 'Hosts', icon: icons.host },
];

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
  const { theme, toggle } = useTheme();
  const ThemeIcon = theme === 'dark' ? icons.themeLight : icons.themeDark;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <NavLink to="/" className={styles.logo} aria-label="Mobile Hub home">
          <BrandLogo />
        </NavLink>

        <nav className={styles.nav} aria-label="Main">
          {navItems.map(({ to, label, icon: Icon }) => (
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
