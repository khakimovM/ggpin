// Shared components built from the Claude Design handoff (design/handoff/).
// Consumed as source by web (Next.js) and admin (Vite); no build step.
//
// Rules: no i18n imports here (all text arrives through props), colours come from tokens only,
// and every animation honours reduced motion (OS setting or the data-reduced profile switch).

// Foundations
export { Logo, type LogoProps } from './components/Logo';
export { ThemeProvider, type ThemeProviderProps } from './components/ThemeProvider';
export { Icon, type IconProps } from './components/Icon';
export { Spinner, type SpinnerProps } from './components/Spinner';
export { MoneyText, type MoneyTextProps } from './components/MoneyText';
export { RelativeTime, type RelativeTimeProps } from './components/RelativeTime';

// Actions and inputs
export { Button, buttonVariants, type ButtonProps } from './components/Button';
export { BottomActionBar, type BottomActionBarProps } from './components/BottomActionBar';
export { Input, type InputKind, type InputProps } from './components/Input';
export {
  MoneyInput,
  groupDigits,
  parseSom,
  type MoneyInputProps,
  type QuickAmount,
} from './components/MoneyInput';
export { OtpInput, type OtpInputProps } from './components/OtpInput';
export { Stepper, type StepperProps } from './components/Stepper';
export { Switch, type SwitchProps } from './components/Switch';

// Selection and badges
export { Chip, type ChipProps } from './components/Chip';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './components/SegmentedControl';
export { Badge, type BadgeProps, type BadgeVariant } from './components/Badge';
export { StatusChip, type StatusChipProps, type StatusChipStatus } from './components/StatusChip';
export { Ribbon, type RibbonProps } from './components/Ribbon';
export { StockChip, type StockChipProps } from './components/StockChip';

// Containers and overlays
export { Card, type CardProps } from './components/Card';
export { Avatar, initialsOf, type AvatarProps } from './components/Avatar';
export { Sheet, type SheetProps } from './components/Sheet';
export { Tabs, type TabItem, type TabsProps } from './components/Tabs';
export { Accordion, type AccordionItem, type AccordionProps } from './components/Accordion';
export { Toast, type ToastProps } from './components/Toast';
export { ToastProvider, type ToastProviderProps } from './components/ToastProvider';

// Data view states
export { Skeleton, type SkeletonProps } from './components/Skeleton';
export { EmptyState, type EmptyStateProps } from './components/EmptyState';
export { ErrorState, type ErrorStateProps } from './components/ErrorState';
export {
  Timeline,
  type TimelineItem,
  type TimelineProps,
  type TimelineState,
} from './components/Timeline';

// Hooks and helpers
export { useTheme, type ThemeName, type ThemePreference } from './lib/theme-context';
export { useToast, type ToastOptions, type ToastTone } from './lib/toast-context';
export {
  DURATION,
  EASE,
  REDUCED_FADE,
  SPRING,
  useMediaQuery,
  useReducedMotion,
} from './lib/motion';
export { cn } from './lib/cn';
