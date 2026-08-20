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
  schema_version: 1,
  registry_revision: 0,
  default_profile_id: null,
  active_profile_id: null,
  migration_warning: null,
  profiles: [],
};

export function useNtripProfiles(baseUrl: string | null | undefined) {
  const baseIdentity = baseUrl?.trim().replace(/\/$/, "") || null;
  const [registry, setRegistry] = useState<NtripProfileRegistry>(EMPTY_REGISTRY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationKey, setMutationKey] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const mutationKeyRef = useRef<string | null>(null);
  const mutationGenerationRef = useRef(0);
  const currentBaseRef = useRef<string | null>(baseIdentity);
  currentBaseRef.current = baseIdentity;

  const reload = useCallback(async () => {
    const requestedBase = baseIdentity;
    const generation = ++requestGenerationRef.current;
    if (!requestedBase) {
      setRegistry(EMPTY_REGISTRY);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await listNtripProfiles(requestedBase);
      if (
        currentBaseRef.current === requestedBase &&
        requestGenerationRef.current === generation
      ) setRegistry(next);
    } catch (requestError) {
      if (
        currentBaseRef.current === requestedBase &&
        requestGenerationRef.current === generation
      ) {
        setError(requestError instanceof Error ? requestError.message : "Failed to load NTRIP profiles.");
      }
    } finally {
      if (
        currentBaseRef.current === requestedBase &&
        requestGenerationRef.current === generation
      ) setLoading(false);
    }
  }, [baseIdentity]);

  useEffect(() => {
    mutationGenerationRef.current += 1;
    mutationKeyRef.current = null;
    setMutationKey(null);
    setRegistry(EMPTY_REGISTRY);
    setError(null);
    void reload();
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [reload]);

  const mutate = useCallback(async (key: string, action: (revision: number) => Promise<void>) => {
    const mutationBase = baseIdentity;
    if (!mutationBase) throw new Error("Connect and authenticate to the rover first.");
    if (mutationKeyRef.current) throw new Error("Another NTRIP profile update is already in progress.");
    const mutationGeneration = ++mutationGenerationRef.current;
    mutationKeyRef.current = key;
    setMutationKey(key);
    setError(null);
    try {
      await action(registry.registry_revision);
      if (
        currentBaseRef.current !== mutationBase ||
        mutationGenerationRef.current !== mutationGeneration
      ) return false;
      await reload();
      return true;
    } catch (mutationError) {
      if (
        currentBaseRef.current !== mutationBase ||
        mutationGenerationRef.current !== mutationGeneration
      ) return false;
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
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationKeyRef.current = null;
        setMutationKey(null);
      }
    }
  }, [baseIdentity, registry.registry_revision, reload]);

  const createProfile = useCallback(
    (input: NtripProfileCreateInput) => mutate("create", (revision) =>
      createNtripProfile(baseIdentity!, input, revision)
    ),
    [baseIdentity, mutate]
  );

  const updateProfile = useCallback(
    (profileId: string, input: NtripProfileUpdateInput) => mutate(`edit:${profileId}`, (revision) =>
      updateNtripProfile(baseIdentity!, profileId, input, revision)
    ),
    [baseIdentity, mutate]
  );

  const removeProfile = useCallback(
    (profileId: string) => mutate(`delete:${profileId}`, (revision) =>
      deleteNtripProfile(baseIdentity!, profileId, revision)
    ),
    [baseIdentity, mutate]
  );

  const setDefaultProfile = useCallback(
    (profileId: string) => mutate(`default:${profileId}`, (revision) =>
      setDefaultNtripProfile(baseIdentity!, profileId, revision)
    ),
    [baseIdentity, mutate]
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
