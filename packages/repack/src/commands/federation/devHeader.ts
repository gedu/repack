import * as colors from 'colorette';
import { logoStr, repackGradient } from '../common/logo.js';

const DESCRIPTION =
  'federation dev — one supervised session for your module-federation workspace';

/**
 * The one-line key legend printed under the banner: the wizard's clack
 * chrome carries per-step hints, but the global controls (cancel) and the
 * overall gesture vocabulary need one always-visible home.
 */
export const DEV_SESSION_LEGEND =
  '↑↓ move · space toggle · enter confirm · Ctrl-C cancel';

/**
 * The one-shot session banner `react-native federation-dev` prints before
 * any wizard, plan or status block takes over stdout (start.ts logo
 * precedent). Pure: the caller decides `colors` (TTY and color support) and
 * owns the trailing newline.
 *
 * Color mode reuses the shared gradient ASCII art from `logo.ts` (single
 * source — never a second copy of the art). Plain mode is what CI, pipes
 * and `NO_COLOR` get: text only, zero ANSI bytes.
 */
export function devHeader(
  version: string,
  options: { colors: boolean }
): string {
  // The legend closes the banner: dim in color mode, plain bytes elsewhere.
  const legend = options.colors
    ? colors.dim(DEV_SESSION_LEGEND)
    : DEV_SESSION_LEGEND;
  if (options.colors) {
    return `${repackGradient.multiline(logoStr)}\n${version} · ${DESCRIPTION}\n${legend}`;
  }
  return `Re.Pack v${version} — federation dev\n${version} · ${DESCRIPTION}\n${legend}`;
}
