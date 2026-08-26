import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Field } from 'react-design-kit';
import type { ApiError } from '@/services/api';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { useAuth } from './useAuth';
import styles from './LoginPage.module.css';

type Mode = 'login' | 'register';

export function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Send the user back where they were headed before being bounced here.
  const from = (location.state as { from?: string } | null)?.from ?? '/devices';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return; // guard double-submit
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, name, password);
      navigate(from, { replace: true });
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message ?? 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <BrandLogo />
        </div>

        <h1 className={styles.title}>{mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
        <p className={styles.subtitle}>
          {mode === 'login'
            ? 'Sign in to lock devices and trigger builds and runs.'
            : 'The first account created on a new instance becomes the administrator.'}
        </p>

        <form className={styles.form} onSubmit={(e) => void onSubmit(e)} noValidate>
          <Field
            label="Email"
            type="email"
            value={email}
            autoComplete="email"
            required
            onChange={(e) => setEmail(e.target.value)}
          />

          {mode === 'register' ? (
            <Field
              label="Name"
              value={name}
              autoComplete="name"
              required
              onChange={(e) => setName(e.target.value)}
            />
          ) : null}

          <Field
            label="Password"
            type="password"
            value={password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            hint={mode === 'register' ? 'At least 8 characters.' : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error ? (
            <div className={styles.error} role="alert">
              {error}
            </div>
          ) : null}

          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <p className={styles.switch}>
          {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}{' '}
          <button
            type="button"
            className={styles.switchButton}
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
