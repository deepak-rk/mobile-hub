import { BuildProviderName } from '../../../config/org-config.schema';
import { BuildProvider } from '../build-provider';
import { UrlBuildProvider } from './url-build-provider';
import { UnimplementedBuildProvider } from './unimplemented-build-provider';

export function getBuildProvider(name: BuildProviderName): BuildProvider {
  switch (name) {
    case 'url':
      return new UrlBuildProvider();
    case 'nexus':
    case 's3':
    case 'webhook':
      return new UnimplementedBuildProvider(name);
  }
}
