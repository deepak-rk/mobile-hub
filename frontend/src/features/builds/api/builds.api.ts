import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { Build } from '../types';

export function useBuilds() {
  return useQuery({
    queryKey: ['builds'],
    queryFn: async () => (await api.get<Build[]>('/builds')).data,
    // Polls only while a fetch is in progress, so the download bar moves
    // (the backend samples `downloadedBytes` ~1s) and the row reaches
    // ready/corrupt without a manual reload. Idle otherwise.
    refetchInterval: (query) =>
      query.state.data?.some((b) => b.status === 'downloading' || b.status === 'validating') ? 2000 : false,
  });
}

/**
 * Removes a build's local artifact, reclaiming its disk space.
 *
 * Not a delete: the record survives as `purged`, so the version stays in the
 * catalog and can be fetched again. The backend refuses (409) while an install
 * is still reading the file.
 */
/**
 * Downloads a purged build's artifact again from the source on its record.
 * The counterpart to purge — without it, reclaiming space was one-way.
 */
export function useRefetchBuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (buildId: string) => (await api.post<Build>(`/builds/${buildId}/refetch`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['builds'] });
    },
  });
}

export function usePurgeBuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (buildId: string) => (await api.post<Build>(`/builds/${buildId}/purge`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['builds'] });
    },
  });
}
