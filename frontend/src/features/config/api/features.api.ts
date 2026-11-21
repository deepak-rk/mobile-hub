import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';

/** The org's module toggles, as served by `GET /api/config/features`. */
export interface FeatureToggles {
  builds: boolean;
  execution: boolean;
  analytics: boolean;
  streaming: boolean;
}

export type Feature = keyof FeatureToggles;

export function useFeatures() {
  return useQuery({
    queryKey: ['config', 'features'],
    queryFn: async () => (await api.get<FeatureToggles>('/config/features')).data,
    // Toggles change by a config edit + reload, not by anything a user does
    // in the UI, so there is no point refetching on every window focus.
    staleTime: 5 * 60_000,
  });
}

/**
 * True only when the server has *said* the module is off. While the request
 * is loading, or if it failed, the answer is unknown, and unknown is not
 * disabled: hiding every module because one request blipped would make a
 * working hub look empty. The module's own routes still answer
 * FEATURE_DISABLED, so erring towards showing is safe.
 */
export function useFeatureDisabled(feature: Feature): boolean {
  const { data } = useFeatures();
  return data?.[feature] === false;
}
