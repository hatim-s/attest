import { getRouteApi } from '@tanstack/react-router';

const workspaceRoute = getRouteApi('/projects/$projectKey');

/** The project every workspace page reads from; only valid below `/projects/$projectKey`. */
const useProjectKey = (): string => workspaceRoute.useParams().projectKey;

export { useProjectKey };
