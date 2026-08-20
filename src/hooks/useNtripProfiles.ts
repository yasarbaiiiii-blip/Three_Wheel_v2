import { useCallback, useEffect, useRef, useState } from "react";
import {
  createNtripProfile,
  deleteNtripProfile,
  listNtripProfiles,
  NtripProfileConflictError,
  setDefaultNtripProfile,
  updateNtripProfile,
} from "../api/rtkProfiles";
import type {
  NtripProfileCreateInput,
  NtripProfileRegistry,
  NtripProfileUpdateInput,
} from "../types/appRuntime";

const EMPTY_REGISTRY: NtripProfileRegistry = {
  registry_revision: 0,
  default_profile_id: null,
  active_profile_id: null,
  profiles: [],
};

export function useNtripProfiles(baseUrl: string | null | undefined) {
  const [registry, setRegistry] = useState<NtripProfileRegistry>(EMPTY_REGISTRY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationKey, setMutationKey] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const mutationKeyRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    if (!baseUrl) {
      setRegistry(EMPTY_REGISTRY);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await listNtripProfiles(baseUrl);
      if (requestGenerationRef.current === generation) setRegistry(next);
    } catch (requestError) {
      if (requestGenerationRef.current === generation) {
        setError(requestError instanceof Error ? requestError.message : "Failed to load NTRIP profiles.");
      }
    } finally {
      if (requestGenerationRef.current === generation) setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void reload();
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [reload]);

  const mutate = useCallback(async (key: string, action: (revision: number) => Promise<void>) => {
    if (!baseUrl) throw new Error("Connect and authenticate to the rover first.");
    if (mutationKeyRef.current) throw new Error("Another NTRIP profile update is already in progress.");
    mutationKeyRef.current = key;
    setMutationKey(key);
    setError(null);
    try {
      await action(registry.registry_revision);
      await reload();
    } catch (mutationError) {
      const message = mutationError instanceof Error
        ? mutationError.message
        : "NTRIP profile request failed.";
      setError(message);
      if (mutationError instanceof NtripProfileConflictError) {
        await reload();
        setError(message);
      }
      throw mutationError;
    } finally {
      mutationKeyRef.current = null;
      setMutationKey(null);
    }
  }, [baseUrl, registry.registry_revision, reload]);

  const createProfile = useCallback(
    (input: NtripProfileCreateInput) => mutate("create", (revision) =>
      createNtripProfile(baseUrl!, input, revision)
    ),
    [baseUrl, mutate]
  );

  const updateProfile = useCallback(
    (profileId: string, input: NtripProfileUpdateInput) => mutate(`edit:${profileId}`, (revision) =>
      updateNtripProfile(baseUrl!, profileId, input, revision)
    ),
    [baseUrl, mutate]
  );

  const removeProfile = useCallback(
    (profileId: string) => mutate(`delete:${profileId}`, (revision) =>
      deleteNtripProfile(baseUrl!, profileId, revision)
    ),
    [baseUrl, mutate]
  );

  const setDefaultProfile = useCallback(
    (profileId: string) => mutate(`default:${profileId}`, (revision) =>
      setDefaultNtripProfile(baseUrl!, profileId, revision)
    ),
    [baseUrl, mutate]
  );

  return {
    ...registry,
    loading,
    error,
    mutationKey,
    reload,
    createProfile,
    updateProfile,
    removeProfile,
    setDefaultProfile,
  };
}
