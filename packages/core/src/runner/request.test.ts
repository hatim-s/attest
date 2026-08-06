import { AGENT_PROTOCOL } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { buildAgentRequest, resolveInvocationEnv } from './request.js';

describe('buildAgentRequest', () => {
  it('builds a single-turn request and includes params only when present', () => {
    const withoutParams = buildAgentRequest('run-1', { id: 'case-1', input: { value: 1 } });
    const withParams = buildAgentRequest('run-1', {
      id: 'case-2',
      input: 'hello',
      params: { locale: 'en' },
    });

    expect(withoutParams).toEqual({
      protocol: AGENT_PROTOCOL,
      run_id: 'run-1',
      case_id: 'case-1',
      input: { value: 1 },
    });
    expect(withParams.params).toEqual({ locale: 'en' });
    expect(withParams).not.toHaveProperty('messages');
  });
});

describe('resolveInvocationEnv', () => {
  it('forwards exactly the sanctioned base set, present allowlisted values, and mandatory attest values', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/bin',
      HOME: '/home/test',
      TMPDIR: '/tmp/test',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      PRESENT_SECRET: 'present',
      BLOCKED_SECRET: 'blocked',
    };
    const environment = resolveInvocationEnv(['PRESENT_SECRET', 'ABSENT_SECRET'], base, {
      runId: 'run-1',
      caseId: 'case-1',
    });

    expect(environment).toEqual({
      PATH: '/bin',
      HOME: '/home/test',
      TMPDIR: '/tmp/test',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      PRESENT_SECRET: 'present',
      ATTEST_RUN_ID: 'run-1',
      ATTEST_CASE_ID: 'case-1',
      ATTEST_PROTOCOL: AGENT_PROTOCOL,
    });
    expect(environment).not.toHaveProperty('ABSENT_SECRET');
    expect(environment).not.toHaveProperty('BLOCKED_SECRET');
  });

  it('lets mandatory attest values override colliding allowlisted values', () => {
    const environment = resolveInvocationEnv(
      ['ATTEST_RUN_ID'],
      { ATTEST_RUN_ID: 'stale' },
      { runId: 'current', caseId: 'case-1' },
    );

    expect(environment.ATTEST_RUN_ID).toBe('current');
  });
});
