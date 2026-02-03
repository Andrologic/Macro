// Mock data for file changes in Implement mode

export interface FileChangeEntry {
  id: string;
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  reviewed: boolean;
  originalContent: string;
  modifiedContent: string;
  language: string;
}

export const mockFileChanges: FileChangeEntry[] = [
  {
    id: 'change-1',
    path: 'src/components/auth/LoginForm.tsx',
    status: 'added',
    additions: 87,
    deletions: 0,
    reviewed: false,
    language: 'typescript',
    originalContent: '',
    modifiedContent: `import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

interface LoginFormProps {
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({ onSuccess, onError }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    try {
      await login(email, password);
      onSuccess?.();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <Button type="submit" disabled={isLoading} className="w-full">
        {isLoading ? 'Signing in...' : 'Sign In'}
      </Button>
    </form>
  );
};`,
  },
  {
    id: 'change-2',
    path: 'src/hooks/useAuth.ts',
    status: 'added',
    additions: 45,
    deletions: 0,
    reviewed: false,
    language: 'typescript',
    originalContent: '',
    modifiedContent: `import { create } from 'zustand';

interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,

  login: async (email: string, password: string) => {
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    if (email && password) {
      set({
        user: { id: '1', email, name: email.split('@')[0] },
        isAuthenticated: true,
      });
    } else {
      throw new Error('Invalid credentials');
    }
  },

  logout: () => {
    set({ user: null, isAuthenticated: false });
  },
}));`,
  },
  {
    id: 'change-3',
    path: 'src/services/authService.ts',
    status: 'modified',
    additions: 23,
    deletions: 8,
    reviewed: true,
    language: 'typescript',
    originalContent: `import { apiClient } from './apiClient';

export const authService = {
  async login(email: string, password: string) {
    return apiClient.post('/auth/login', { email, password });
  },
  
  async logout() {
    return apiClient.post('/auth/logout');
  },
};`,
    modifiedContent: `import { apiClient } from './apiClient';

interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
}

export const authService = {
  async login(email: string, password: string): Promise<LoginResponse> {
    const response = await apiClient.post('/auth/login', { email, password });
    localStorage.setItem('auth_token', response.token);
    return response;
  },
  
  async logout(): Promise<void> {
    localStorage.removeItem('auth_token');
    return apiClient.post('/auth/logout');
  },

  async refreshToken(): Promise<string> {
    const response = await apiClient.post('/auth/refresh');
    localStorage.setItem('auth_token', response.token);
    return response.token;
  },

  getToken(): string | null {
    return localStorage.getItem('auth_token');
  },
};`,
  },
  {
    id: 'change-4',
    path: 'src/types/auth.ts',
    status: 'added',
    additions: 18,
    deletions: 0,
    reviewed: false,
    language: 'typescript',
    originalContent: '',
    modifiedContent: `export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role: 'admin' | 'user' | 'guest';
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface LoginCredentials {
  email: string;
  password: string;
}`,
  },
  {
    id: 'change-5',
    path: 'src/utils/validation.ts',
    status: 'modified',
    additions: 12,
    deletions: 2,
    reviewed: false,
    language: 'typescript',
    originalContent: `export const isValidEmail = (email: string): boolean => {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
};`,
    modifiedContent: `export const isValidEmail = (email: string): boolean => {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
};

export const isValidPassword = (password: string): boolean => {
  // At least 8 chars, 1 uppercase, 1 lowercase, 1 number
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).{8,}$/.test(password);
};

export const validateLoginForm = (email: string, password: string): string[] => {
  const errors: string[] = [];
  if (!isValidEmail(email)) errors.push('Invalid email format');
  if (!isValidPassword(password)) errors.push('Password does not meet requirements');
  return errors;
};`,
  },
  {
    id: 'change-6',
    path: 'tests/auth.test.ts',
    status: 'added',
    additions: 32,
    deletions: 0,
    reviewed: false,
    language: 'typescript',
    originalContent: '',
    modifiedContent: `import { describe, it, expect, vi } from 'vitest';
import { authService } from '../src/services/authService';

describe('authService', () => {
  it('should login successfully with valid credentials', async () => {
    const result = await authService.login('test@example.com', 'Password123');
    expect(result.token).toBeDefined();
    expect(result.user.email).toBe('test@example.com');
  });

  it('should store token in localStorage after login', async () => {
    await authService.login('test@example.com', 'Password123');
    expect(localStorage.getItem('auth_token')).toBeDefined();
  });

  it('should remove token on logout', async () => {
    localStorage.setItem('auth_token', 'test-token');
    await authService.logout();
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('should return stored token', () => {
    localStorage.setItem('auth_token', 'my-token');
    expect(authService.getToken()).toBe('my-token');
  });
});`,
  },
];

// Helper to build folder tree structure
export interface FolderNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: FolderNode[];
  fileChange?: FileChangeEntry;
}

export function buildFolderTree(changes: FileChangeEntry[]): FolderNode[] {
  const root: FolderNode[] = [];

  for (const change of changes) {
    const parts = change.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let existing = current.find((n) => n.name === part);

      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          type: isFile ? 'file' : 'folder',
          children: isFile ? undefined : [],
          fileChange: isFile ? change : undefined,
        };
        current.push(existing);
      }

      if (!isFile && existing.children) {
        current = existing.children;
      }
    }
  }

  return root;
}
