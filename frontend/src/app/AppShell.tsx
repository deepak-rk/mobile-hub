import { NavLink, Outlet } from 'react-router-dom';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { Button } from '@/components/ui/Button';
import { icons, iconSize } from '@/lib/icons';
import { useTheme } from '@/lib/theme';
import styles from './AppShell.module.css';

const navItems = [
  { to: '/devices', label: 'Devices', icon: icons.device },
  { to: '/builds', label: 'Builds', icon: icons.build },
  { to: '/execution', label: 'Execution', icon: icons.execution },
  { to: '/analytics', label: 'Analytics', icon: icons.analytics },
  { to: '/servers', label: 'Hosts', icon: icons.host },
];

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
        </div>
      </header>

      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
