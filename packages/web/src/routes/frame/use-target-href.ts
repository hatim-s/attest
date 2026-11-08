import { useRouter } from '@tanstack/react-router';
import type { ShellTarget } from '../../shell/navigation.js';
import { targetLink } from './shell-targets.js';

/** A real anchor href for a shell target, in the router's own history format. */
const useTargetHref = () => {
  const router = useRouter();

  return (target: ShellTarget) =>
    router.history.createHref(router.buildLocation(targetLink(target)).href);
};

export { useTargetHref };
