import { Icon as Iconify } from '@iconify/react/offline';
import { icons, type IconName } from '../lib/icons.ts';

/**
 * The offline entry point of `@iconify/react` ships without the API client, so
 * a missing glyph is a build-time mistake rather than a runtime network call.
 */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <Iconify icon={icons[name]} className={className} aria-hidden />;
}
