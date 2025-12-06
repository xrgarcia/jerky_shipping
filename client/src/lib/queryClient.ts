import { QueryClient, QueryFunction } from "@tanstack/react-query";

class ApiError extends Error {
  status: number;
  data: any;
  
  constructor(status: number, message: string, data?: any) {
    super(message);
    this.status = status;
    this.data = data;
    this.name = 'ApiError';
  }
}

let isRedirectingToLogin = false;

function redirectToLogin() {
  if (isRedirectingToLogin) return;
  isRedirectingToLogin = true;
  
  if (window.location.pathname !== '/login') {
    console.log('[QueryClient] 401 detected - redirecting to login');
    window.location.href = '/login';
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, 'Session expired', null);
    }
    
    const text = (await res.text()) || res.statusText;
    
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
    }
    
    throw new ApiError(res.status, `${res.status}: ${text}`, data);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw" | "redirect";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (res.status === 401) {
      if (unauthorizedBehavior === "returnNull") {
        return null;
      }
      redirectToLogin();
      throw new ApiError(401, 'Session expired', null);
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "redirect" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
