import type {
  AvatarStyle,
  CritiqueStance,
  ErrorCode,
  ProfileItemKind,
  ProfileItemSource,
  ProviderKey,
  RunStatus,
  StepName,
  ThemeName,
} from './constants';
import type { RunMetrics, RevealPayload, DissentRow, PartialScore } from './events';

/**
 * DTOs crossing the HTTP boundary. The server serialises rows into these and
 * the client never sees a raw Drizzle row. Keeping them here (not in `lib/`)
 * means the client bundle never imports a server-only module to get a type.
 */

// --- Agents ----------------------------------------------------------------

export interface AgentDTO {
  id: string;
  seatKey: string;
  name: string;
  isMeAgent: boolean;
  lensPrompt: string;
  provider: ProviderKey;
  modelId: string;
  temperature: number;
  weight: number;
  avatarStyle: AvatarStyle;
  avatarSeed: string;
  avatarSvg: string | null;
  accentColor: string;
  accentToken: string;
  iconName: string;
  enabled: boolean;
  orderIndex: number;
}

export interface AgentsResponse {
  agents: AgentDTO[];
  normalisedWeights: Record<string, number>;
  totalRawWeight: number;
}

/** The frozen subset snapshotted into `runs.agent_snapshot`. */
export interface AgentSnapshotEntry {
  id: string;
  seatKey: string;
  name: string;
  isMeAgent: boolean;
  lensPrompt: string;
  provider: ProviderKey;
  modelId: string;
  temperature: number;
  rawWeight: number;
  normalisedWeight: number;
  accentColor: string;
  accentToken: string;
  orderIndex: number;
  enabled: boolean;
}

// --- Profile ---------------------------------------------------------------

export interface ProfileItemDTO {
  id: string;
  kind: ProfileItemKind;
  label: string;
  detail: string;
  source: ProfileItemSource;
  confidence: number;
  locked: boolean;
  stale: boolean;
  orderIndex: number;
}

export interface ProfileDTO {
  id: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  summaryText: string;
  authorBrief: string;
  generatedAt: number;
  lastManualEditAt: number | null;
}

export interface IngestRunDTO {
  id: string;
  source: string;
  startedAt: number;
  finishedAt: number | null;
  itemCount: number;
  error: string | null;
}

export interface ProfileResponse {
  profile: ProfileDTO | null;
  items: ProfileItemDTO[];
  ingestRuns: IngestRunDTO[];
}

export interface ProfileDiff {
  added: Array<{ kind: string; label: string; source: string }>;
  changed: Array<{ label: string; from: string; to: string }>;
  removed: Array<{ kind: string; label: string }>;
  preserved: number;
}

export interface RegenerateResponse {
  draftId: string;
  diff: ProfileDiff;
  itemCount: number;
  warnings: string[];
}

// --- Runs ------------------------------------------------------------------

export interface ProposalDTO {
  id: string;
  agentId: string;
  agentName: string;
  accentToken: string;
  round: number;
  title: string;
  description: string;
  rationale: string;
  feasibilityWeeks: number | null;
  parentProposalId: string | null;
  status: 'active' | 'merged' | 'eliminated';
  createdAt: number;
}

export interface CritiqueDTO {
  id: string;
  agentId: string;
  agentName: string;
  accentToken: string;
  targetProposalId: string;
  stance: CritiqueStance;
  comment: string;
  round: number;
}

export interface VoteDTO {
  id: string;
  agentId: string;
  agentName: string;
  accentToken: string;
  proposalId: string;
  score: number;
  weightAtVote: number;
  weightedScore: number;
  comment: string;
}

export interface ProposalScoreDTO {
  proposalId: string;
  title: string;
  finalScore: number;
  meanScore: number;
  voteCount: number;
  leadAccent: string;
  perSeat: Array<{ agentId: string; seatName: string; accentToken: string; score: number; weighted: number }>;
}

export interface RunEventDTO {
  id: number;
  seq: number;
  type: string;
  agentId: string | null;
  step: string | null;
  payload: unknown;
  createdAt: number;
}

export interface RunDetailResponse {
  run: {
    id: string;
    seedPrompt: string;
    seedMode: 'vague' | 'specific';
    status: RunStatus;
    currentStep: string;
    stepIndex: number;
    round: number;
    tokensIn: number;
    tokensOut: number;
    costEstimateUsd: number;
    llmCalls: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    profileId: string | null;
    agentSnapshot: AgentSnapshotEntry[];
  };
  agents: AgentDTO[];
  proposals: ProposalDTO[];
  critiques: CritiqueDTO[];
  votes: VoteDTO[];
  scores: ProposalScoreDTO[];
  metrics: RunMetrics | null;
  reveal: RevealPayload | null;
  dissent: DissentRow[];
  partialScores: PartialScore[];
  failedSeats: Array<{ agentId: string; seatName: string; code: string; message: string }>;
  events?: RunEventDTO[];
}

export interface RunCompareResponse {
  a: RunDetailResponse;
  b: RunDetailResponse;
  deltas: {
    metric: string;
    a: number | boolean | string | null;
    b: number | boolean | string | null;
    delta: number | null;
  }[];
  seatConfigDiff: Array<{
    seatKey: string;
    name: string;
    field: string;
    a: string;
    b: string;
  }>;
}

// --- Settings --------------------------------------------------------------

export interface SettingsDTO {
  theme: ThemeName;
  budgetUsd: number;
  maxTokens: number;
  maxCalls: number;
  staggerCadenceMs: number;
  refineEnabled: boolean;
  maxCritiquesPerAgent: number;
  reasoningPanelEnabled: boolean;
  defaultAvatarStyle: AvatarStyle;
  temperatureBySeatClass: { me: number; lens: number };
  requestTimeoutMs: number;
  retries: number;
  concurrency: number;
}

export interface ProvidersDTO {
  glm: { configured: boolean; baseUrl: string };
  tavily: { configured: boolean };
  github: { configured: boolean; username: string | null };
}

export interface SettingsResponse {
  settings: SettingsDTO;
  providers: ProvidersDTO;
  pricing: Array<{
    provider: string;
    modelId: string;
    inputPerMtokUsd: number;
    outputPerMtokUsd: number;
    updatedAt: number;
  }>;
  pricingUpdatedAt: number | null;
}

// --- API envelope ----------------------------------------------------------

export interface ApiError {
  error: { code: ErrorCode | string; message: string };
}

export type StepStatus = 'pending' | 'active' | 'complete' | 'failed' | 'skipped';

export interface StepProgress {
  step: StepName;
  status: StepStatus;
}

export interface HealthResponse {
  ok: boolean;
  db: boolean;
  providers: ProvidersDTO;
}
