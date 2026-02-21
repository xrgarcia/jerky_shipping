import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCallback, useEffect, useRef, useState } from "react";

export function useUserPreference<T>(
  namespace: string,
  key: string,
  defaultValue: T,
  options?: { debounceMs?: number }
) {
  const debounceMs = options?.debounceMs ?? 500;
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localValue, setLocalValue] = useState<T>(defaultValue);
  const [isInitialized, setIsInitialized] = useState(false);

  const query = useQuery<{ value: T }>({
    queryKey: ["/api/user-preferences", namespace, key],
    retry: false,
  });

  useEffect(() => {
    if (query.data && !isInitialized) {
      setLocalValue(query.data.value as T);
      setIsInitialized(true);
    } else if (query.isError && !isInitialized) {
      setLocalValue(defaultValue);
      setIsInitialized(true);
    }
  }, [query.data, query.isError, isInitialized, defaultValue]);

  const mutation = useMutation({
    mutationFn: async (value: T) => {
      const res = await apiRequest("PUT", `/api/user-preferences/${namespace}/${key}`, { value });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user-preferences", namespace, key] });
    },
  });

  const setValue = useCallback(
    (newValue: T | ((prev: T) => T)) => {
      const resolved = typeof newValue === "function"
        ? (newValue as (prev: T) => T)(localValue)
        : newValue;
      setLocalValue(resolved);

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = setTimeout(() => {
        mutation.mutate(resolved);
      }, debounceMs);
    },
    [localValue, debounceMs, mutation, namespace, key]
  );

  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  return {
    value: localValue,
    setValue,
    isLoading: query.isLoading,
    isSaving: mutation.isPending,
    isInitialized,
  };
}

export function useUserPreferences(namespace: string) {
  return useQuery<Record<string, unknown>>({
    queryKey: ["/api/user-preferences", namespace],
    retry: false,
  });
}
