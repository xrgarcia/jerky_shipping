import { useState, useEffect } from 'react';
import { Loader2, ChevronDown, Server } from 'lucide-react';
import logoImage from '../assets/logo.png';

interface EnvironmentInfo {
  name: string;
  label: string;
  serverUrl: string;
}

function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentInfo[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<string>('production');
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);

  useEffect(() => {
    loadEnvironments();
  }, []);

  const loadEnvironments = async () => {
    try {
      const result = await window.electronAPI.environment.list();
      if (result.success && result.data) {
        setEnvironments(result.data);
      }
      
      const currentEnv = await window.electronAPI.environment.get();
      if (currentEnv.success && currentEnv.data) {
        setSelectedEnv(currentEnv.data);
      }
    } catch (err) {
      console.error('Failed to load environments:', err);
    }
  };

  const handleEnvChange = async (envName: string) => {
    setSelectedEnv(envName);
    setShowEnvDropdown(false);
    await window.electronAPI.environment.set(envName);
  };

  const handleLogin = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.auth.login();
      if (!result.success) {
        setError(result.error || 'Login failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const currentEnv = environments.find(e => e.name === selectedEnv);
  const isDev = selectedEnv === 'development';

  return (
    <div className="h-full flex flex-col">
      <div className="h-12 drag-region bg-[#1a1a1a] border-b border-[#333]" />
      
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-20 h-20 mb-6 rounded-2xl overflow-hidden">
          <img src={logoImage} alt="Jerky Ship Connect" className="w-full h-full object-cover" />
        </div>
        
        <h1 className="text-2xl font-semibold text-white mb-2">
          Jerky Ship Connect
        </h1>
        
        <p className="text-[#999] text-center mb-6 max-w-[280px]">
          Sign in with your Jerky.com Google Workspace account to get started
        </p>

        <div className="relative mb-6 w-full max-w-[280px]">
          <button
            onClick={() => setShowEnvDropdown(!showEnvDropdown)}
            className={`w-full flex items-center justify-between gap-2 px-4 py-3 rounded-lg border transition-colors ${
              isDev 
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' 
                : 'bg-[#2a2a2a] border-[#444] text-white'
            }`}
            data-testid="button-env-selector"
          >
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4" />
              <span className="font-medium">{currentEnv?.label || 'Select Environment'}</span>
            </div>
            <ChevronDown className={`w-4 h-4 transition-transform ${showEnvDropdown ? 'rotate-180' : ''}`} />
          </button>
          
          {showEnvDropdown && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-[#2a2a2a] border border-[#444] rounded-lg overflow-hidden z-10 shadow-xl">
              {environments.map((env) => (
                <button
                  key={env.name}
                  onClick={() => handleEnvChange(env.name)}
                  className={`w-full px-4 py-3 text-left transition-colors flex flex-col ${
                    env.name === selectedEnv 
                      ? 'bg-primary-500/20 text-white' 
                      : 'text-[#ccc] hover:bg-[#333]'
                  }`}
                  data-testid={`button-env-${env.name}`}
                >
                  <span className="font-medium">{env.label}</span>
                  <span className="text-xs text-[#888] truncate">{env.serverUrl}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {isDev && (
          <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-400 text-sm text-center max-w-[280px]">
            Development mode - connecting to test server
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm text-center max-w-[280px]">
            {error}
          </div>
        )}

        <button
          onClick={handleLogin}
          disabled={loading}
          data-testid="button-login"
          className="flex items-center gap-3 px-6 py-3 bg-white hover:bg-gray-100 text-gray-800 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
          )}
          Sign in with Google
        </button>

        <p className="mt-8 text-xs text-[#666] text-center">
          Only @jerky.com accounts can sign in
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
