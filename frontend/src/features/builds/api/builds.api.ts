import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { Build } from '../types';

export function useBuilds() {
  return useQuery({
    queryKey: ['builds'],
    queryFn: async () => (await api.get<Build[]>('/builds')).data,
  });
}

/**
 * Removes a build's local artifact, reclaiming its disk space.
 *
 * Not a delete: the record survives as `purged`, so the version stays in the
 * catalog and can be fetched again. The backend refuses (409) while an install
 * is still reading the file.
 */
export function usePurgeBuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (buildId: string) => (await api.post<Build>(`/builds/${buildId}/purge`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['builds'] });
    },
  });
}
