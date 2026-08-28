/**
 * The single place domain concepts map to Lucide icons. Import from here —
 * never reference a Lucide icon name directly in a component, so the visual
 * language stays consistent and one edit changes it everywhere.
 * See docs/ui-guidelines.md §6.
 */
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  KeyRound,
  Lock,
  LockOpen,
  MinusCircle,
  Moon,
  Package,
  PackageCheck,
  Play,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Sun,
  Terminal,
  WifiOff,
  XCircle,
} from 'lucide-react';

export const icons = {
  // Domain objects
  device: Smartphone,
  host: Server,
  build: Package,
  execution: Terminal,
  analytics: BarChart3,
  credential: KeyRound,

  // Lock state
  locked: Lock,
  unlocked: LockOpen,

  // Streaming
  stream: Radio,

  // Run / build lifecycle
  running: Play,
  passed: CheckCircle2,
  failed: XCircle,
  cancelled: MinusCircle,
  downloading: Download,
  validating: ShieldCheck,
  corrupt: AlertTriangle,
  ready: PackageCheck,
  offline: WifiOff,

  // Generic
  dot: Circle,
  retry: RefreshCw,
  copy: Copy,
  themeDark: Moon,
  themeLight: Sun,
} as const;

/** Icon sizes by context (guidelines §6). */
export const iconSize = {
  dense: 14,
  control: 16,
  header: 20,
  empty: 24,
} as const;
