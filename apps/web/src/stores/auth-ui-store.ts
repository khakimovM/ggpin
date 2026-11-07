import { create } from 'zustand';

// UI-only state: where the sign-out of THIS tab stands. It lives outside the mutation because the
// screen that started it (a page behind AuthGuard) is replaced by the guard while it runs, and the
// guard must keep telling the visitor "signing out" / "sign-out failed" instead of "session ended".
export type LogoutStatus = 'idle' | 'pending' | 'failed';

interface AuthUiState {
  logout: LogoutStatus;
  setLogout: (status: LogoutStatus) => void;
}

export const useAuthUiStore = create<AuthUiState>((set) => ({
  logout: 'idle',
  setLogout: (logout) => set({ logout }),
}));
