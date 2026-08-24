export const GALLERY_KEYS = Object.freeze({
  previousItem: 'ArrowLeft',
  nextItem: 'ArrowRight',
  previousTest: 'ArrowUp',
  nextTest: 'ArrowDown',
  previousMember: '[',
  nextMember: ']',
  playPause: ' ',
  context: 'i',
  fullscreen: 'f',
  escape: 'Escape',
  help: '?',
});

export const GALLERY_LIMITS = Object.freeze({
  pageRows: 100,
  filmstripItems: 9,
  queueItems: 60,
  overviewItems: 64,
  galleryDomNodes: 500,
  retainedDetails: 1,
  retainedSelectedVideos: 1,
  retainedThumbnails: 72,
  retainedPlayback: 25,
  facetOptions: 20,
  announcementCharacters: 320,
});

const MEDIA_KINDS = new Set(['image', 'video']);
const MEMBER_ROLES = new Set(['single', 'baseline', 'actual', 'diff', 'other', 'unknown']);
const FLAG_STATES = new Set(['open', 'resolved', 'dismissed', 'unflagged']);
const REQUEST_SLOTS = ['head', 'query', 'detail', 'availability', 'media', 'thumbnail', 'flag'];
const EMPTY_QUERY = Object.freeze({
  kinds: [],
  statuses: [],
  environments: [],
  featureSuites: [],
  technicalSuites: [],
  targets: [],
  flagStates: [],
  search: '',
  group: 'feature',
  sort: 'attention',
});

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function safeText(value, name, maximum = 1_200, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim() === '')) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function safeStrings(value, name, maximumEntries = 100, maximumLength = 1_200) {
  if (!Array.isArray(value) || value.length > maximumEntries) throw new TypeError(`${name} is invalid.`);
  return value.map((entry) => safeText(entry, name, maximumLength, true));
}

function safeOrdinal(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} is invalid.`);
  return value;
}

function cloneAssociation(value) {
  const association = requireObject(value, 'Gallery audit association');
  return Object.freeze({
    id: safeText(association.id, 'Gallery audit ID', 160),
    title: safeText(association.title, 'Gallery audit title'),
    catalogOrdinal: safeOrdinal(association.catalogOrdinal, 'Gallery audit ordinal', true),
  });
}

export function decodeGalleryQueryRow(value) {
  const row = requireObject(value, 'Gallery query row');
  if (!/^gitem_[a-f0-9]{16}$/.test(row.id ?? '')) throw new TypeError('Gallery query row item ID is invalid.');
  if (!/^gtest_[a-f0-9]{16}$/.test(row.testGroupId ?? '')) throw new TypeError('Gallery query row test-group ID is invalid.');
  if (!MEDIA_KINDS.has(row.kind)) throw new TypeError('Gallery query row media kind is invalid.');
  if (!FLAG_STATES.has(row.flagState)) throw new TypeError('Gallery query row flag state is invalid.');
  const attempt = requireObject(row.attempt, 'Gallery query row attempt');
  const attemptOrdinal = safeOrdinal(attempt.ordinal, 'Gallery attempt ordinal');
  if (attemptOrdinal < 1) throw new TypeError('Gallery attempt ordinal is invalid.');
  const captureTime = row.captureTime === null ? null : safeText(row.captureTime, 'Gallery capture time', 100);
  if (captureTime !== null && Number.isNaN(Date.parse(captureTime))) throw new TypeError('Gallery capture time is invalid.');
  const primaryFeatureSuite = row.primaryFeatureSuite === null
    ? null
    : safeText(row.primaryFeatureSuite, 'Gallery primary feature suite');
  return Object.freeze({
    id: row.id,
    testGroupId: row.testGroupId,
    kind: row.kind,
    title: safeText(row.title, 'Gallery test title'),
    testLabel: safeText(row.testLabel, 'Gallery test label'),
    testTitlePath: Object.freeze(safeStrings(row.testTitlePath, 'Gallery title path', 50)),
    projectName: safeText(row.projectName, 'Gallery project name', 300),
    status: safeText(row.status, 'Gallery status', 120),
    environment: safeText(row.environment, 'Gallery environment', 120),
    featureSuites: Object.freeze(safeStrings(row.featureSuites, 'Gallery feature suites')),
    primaryFeatureSuite,
    primaryAuditCatalogOrdinal: safeOrdinal(row.primaryAuditCatalogOrdinal, 'Gallery primary audit ordinal', true),
    technicalSuite: safeText(row.technicalSuite, 'Gallery technical suite', 1_200, true),
    targets: Object.freeze(safeStrings(row.targets, 'Gallery targets')),
    flagState: row.flagState,
    attempt: Object.freeze({ ordinal: attemptOrdinal, retry: safeOrdinal(attempt.retry, 'Gallery retry') }),
    captureTime,
    available: (() => {
      if (typeof row.available !== 'boolean') throw new TypeError('Gallery query row availability is invalid.');
      return row.available;
    })(),
    visualWarning: (() => {
      if (typeof row.visualWarning !== 'boolean') throw new TypeError('Gallery query row visual warning is invalid.');
      return row.visualWarning;
    })(),
    auditAssociations: Object.freeze((Array.isArray(row.auditAssociations) ? row.auditAssociations : []).map(cloneAssociation)),
  });
}

function cloneMember(value) {
  const member = requireObject(value, 'Gallery media member');
  if (!MEMBER_ROLES.has(member.role)) throw new TypeError('Gallery media member role is invalid.');
  return Object.freeze({
    id: safeText(member.id, 'Gallery member ID', 160),
    name: safeText(member.name, 'Gallery member name'),
    role: member.role,
    contentType: safeText(member.contentType, 'Gallery member content type', 200),
    available: (() => {
      if (typeof member.available !== 'boolean') throw new TypeError('Gallery member availability is invalid.');
      return member.available;
    })(),
    error: member.error === null ? null : safeText(member.error, 'Gallery member error', 4_000, true),
    adapterPosterReference: Object.freeze({
      href: typeof member.poster?.href === 'string' ? member.poster.href : null,
    }),
  });
}

export function decodeGalleryItemDetail(value) {
  const detail = requireObject(value, 'Gallery item detail');
  if (detail.schemaVersion !== 1) throw new TypeError('Gallery item detail schema is unsupported.');
  const item = requireObject(detail.item, 'Gallery item');
  if (!/^gitem_[a-f0-9]{16}$/.test(item.id ?? '') || !MEDIA_KINDS.has(item.kind)) {
    throw new TypeError('Gallery item identity is invalid.');
  }
  const test = requireObject(item.test, 'Gallery item test');
  const attempt = requireObject(item.attempt, 'Gallery item attempt');
  const project = requireObject(item.project, 'Gallery item project');
  const capture = requireObject(item.capture, 'Gallery capture context');
  const members = (Array.isArray(item.members) ? item.members : []).map(cloneMember);
  if (members.length < 1 || members.length > 20) throw new TypeError('Gallery item member count is invalid.');
  const media = (Array.isArray(detail.media) ? detail.media : []).map((entry) => {
    const source = requireObject(entry, 'Gallery media projection');
    const memberId = safeText(source.memberId, 'Gallery media projection member ID', 160);
    if (!members.some((member) => member.id === memberId)) throw new TypeError('Gallery media projection member is invalid.');
    return Object.freeze({
      memberId,
      contentType: safeText(source.contentType, 'Gallery media content type', 200),
      available: (() => {
        if (typeof source.available !== 'boolean') throw new TypeError('Gallery media projection availability is invalid.');
        return source.available;
      })(),
      // This opaque reference is passed back only to the adapter. The core never
      // copies it to a URL-bearing DOM property.
      adapterReference: Object.freeze({ href: typeof source.href === 'string' ? source.href : null }),
      adapterPosterReference: Object.freeze({
        href: typeof source.poster?.href === 'string'
          ? source.poster.href
          : members.find((member) => member.id === memberId)?.adapterPosterReference?.href ?? null,
      }),
    });
  });
  if (media.length !== members.length) throw new TypeError('Gallery media projection count is invalid.');
  const availability = requireObject(detail.availability, 'Gallery item availability');
  if (!['available', 'tombstone'].includes(availability.state) || typeof availability.retryable !== 'boolean') {
    throw new TypeError('Gallery item availability is invalid.');
  }
  return Object.freeze({
    schemaVersion: 1,
    item: Object.freeze({
      id: item.id,
      kind: item.kind,
      test: Object.freeze({
        id: safeText(test.id, 'Gallery test ID', 500),
        title: safeText(test.title, 'Gallery test title'),
        titlePath: Object.freeze(safeStrings(test.titlePath, 'Gallery item title path', 50)),
        file: safeText(test.file, 'Gallery test file', 1_200, true),
        technicalSuite: safeText(test.technicalSuite, 'Gallery technical suite', 1_200, true),
      }),
      attempt: Object.freeze({
        ordinal: safeOrdinal(attempt.ordinal, 'Gallery attempt ordinal'),
        retry: safeOrdinal(attempt.retry, 'Gallery retry'),
        status: safeText(attempt.status, 'Gallery attempt status', 120),
        rawStatus: attempt.rawStatus == null
          ? safeText(attempt.status, 'Gallery raw attempt status', 120)
          : safeText(attempt.rawStatus, 'Gallery raw attempt status', 120),
        statusSource: attempt.statusSource == null
          ? 'raw-live'
          : safeText(attempt.statusSource, 'Gallery status source', 120),
        reviewReasonCodes: Object.freeze(safeStrings(attempt.reviewReasonCodes ?? [], 'Gallery review reason codes', 12, 120)),
        expectedStatus: attempt.expectedStatus === null ? null : safeText(attempt.expectedStatus, 'Gallery expected status', 120),
        startedAt: attempt.startedAt === null ? null : safeText(attempt.startedAt, 'Gallery start time', 100),
        durationMs: Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0 ? attempt.durationMs : 0,
      }),
      project: Object.freeze({
        name: safeText(project.name, 'Gallery project name', 300),
        environment: safeText(project.environment, 'Gallery environment', 120),
        browser: safeText(project.browser, 'Gallery browser', 300),
        deviceClass: safeText(project.deviceClass, 'Gallery device class', 120),
      }),
      auditAssociations: Object.freeze((Array.isArray(item.auditAssociations) ? item.auditAssociations : []).map((association) => {
        const base = cloneAssociation(association);
        return Object.freeze({
          ...base,
          expected: safeText(association.expected, 'Gallery expected behavior', 4_000),
          featureSuite: safeText(association.featureSuite, 'Gallery feature suite'),
        });
      })),
      members: Object.freeze(members),
      comparison: item.comparison && typeof item.comparison === 'object'
        ? Object.freeze({ key: safeText(item.comparison.key, 'Gallery comparison key'), complete: Boolean(item.comparison.complete) })
        : null,
      capture: Object.freeze({
        route: capture.route === null ? null : safeText(capture.route, 'Gallery route', 2_000, true),
        observedState: capture.observedState === null ? null : safeText(capture.observedState, 'Gallery observed state', 4_000, true),
        rationale: capture.rationale === null ? null : safeText(capture.rationale, 'Gallery capture rationale', 4_000, true),
        capturedAt: capture.capturedAt === null ? null : safeText(capture.capturedAt, 'Gallery capture time', 100),
        viewport: capture.viewport && Number.isInteger(capture.viewport.width) && Number.isInteger(capture.viewport.height)
          ? Object.freeze({ width: capture.viewport.width, height: capture.viewport.height })
          : null,
      }),
    }),
    media: Object.freeze(media),
    availability: Object.freeze({
      state: availability.state,
      retryable: availability.retryable,
      message: availability.message === null ? null : safeText(availability.message, 'Gallery availability message', 4_000, true),
    }),
    review: detail.review && typeof detail.review === 'object' ? Object.freeze({
      flagRevision: typeof detail.review.flagRevision === 'string' ? detail.review.flagRevision : null,
      flags: Object.freeze((Array.isArray(detail.review.flags) ? detail.review.flags : []).slice(0, 100).map((value) => {
        const flag = requireObject(value, 'Gallery reviewer flag');
        return Object.freeze({
          flagId: typeof flag.flagId === 'string' ? safeText(flag.flagId, 'Gallery flag ID', 160) : null,
          state: typeof flag.state === 'string' && ['open', 'resolved', 'dismissed'].includes(flag.state) ? flag.state : 'open',
          reviewer: typeof flag.reviewer === 'string' ? safeText(flag.reviewer, 'Gallery reviewer', 120, true) : '',
          note: flag.note === null || flag.note === undefined ? null : safeText(flag.note, 'Gallery flag note', 4_000, true),
          justification: flag.justification === null || flag.justification === undefined
            ? null
            : safeText(flag.justification, 'Gallery flag justification', 4_000, true),
        });
      })),
    }) : Object.freeze({ flagRevision: null, flags: [] }),
  });
}

function normalizedQuery(value = EMPTY_QUERY) {
  const source = value && typeof value === 'object' ? value : {};
  const list = (name) => [...new Set((Array.isArray(source[name]) ? source[name] : [])
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim()))].sort();
  return Object.freeze({
    kinds: Object.freeze(list('kinds').filter((kind) => MEDIA_KINDS.has(kind))),
    statuses: Object.freeze(list('statuses')),
    environments: Object.freeze(list('environments')),
    featureSuites: Object.freeze(list('featureSuites')),
    technicalSuites: Object.freeze(list('technicalSuites')),
    targets: Object.freeze(list('targets')),
    flagStates: Object.freeze(list('flagStates').filter((state) => FLAG_STATES.has(state))),
    search: typeof source.search === 'string' ? source.search.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 1_200) : '',
    group: ['feature', 'technical', 'none'].includes(source.group) ? source.group : 'feature',
    sort: ['attention', 'feature', 'technical', 'audit', 'capture-time'].includes(source.sort) ? source.sort : 'attention',
  });
}

function queryKey(query) {
  return JSON.stringify(normalizedQuery(query));
}

function defaultRequests() {
  return Object.fromEntries(REQUEST_SLOTS.map((slot) => [slot, {
    generation: 0,
    semanticKey: null,
    status: 'idle',
    error: null,
  }]));
}

export function createInitialGalleryState(overrides = {}) {
  const query = normalizedQuery(overrides.query);
  return {
    mode: overrides.mode === 'overview' ? 'overview' : 'workbench',
    phase: 'loading',
    descriptor: null,
    query,
    suiteAnchor: null,
    accepted: {
      contentRevision: null,
      flagRevision: null,
      orderRevision: null,
      items: [],
      total: 0,
      windows: [],
      nextCursor: null,
    },
    pendingRevision: null,
    selection: {
      itemId: null,
      memberId: null,
      outOfFilterAnchor: null,
    },
    detail: null,
    availability: null,
    media: { status: 'idle', itemId: null, memberId: null, source: null, error: null },
    thumbnails: {},
    playback: {},
    layers: {
      fullscreen: false,
      help: false,
      context: true,
      responsivePanel: null,
      focusHistory: [],
    },
    history: [],
    capability: { flagsMutable: false },
    requests: defaultRequests(),
    purged: false,
    ...(overrides.phase ? { phase: overrides.phase } : {}),
  };
}

function requestMatches(state, action) {
  const request = state.requests[action.slot];
  if (!request || request.generation !== action.generation || request.semanticKey !== action.semanticKey) return false;
  if (
    action.contentRevision
    && action.contentRevision !== (state.accepted.contentRevision ?? action.contentRevision)
    && !(action.slot === 'query' && action.acceptPending && state.pendingRevision?.applying)
  ) return false;
  if (['detail', 'availability', 'media', 'flag'].includes(action.slot) && action.itemId && action.itemId !== state.selection.itemId) return false;
  if (action.slot === 'media' && action.memberId && action.memberId !== state.selection.memberId) return false;
  return true;
}

function updateRequest(state, slot, value) {
  return { ...state, requests: { ...state.requests, [slot]: { ...state.requests[slot], ...value } } };
}

function nearestVisibleItem(previousItems, nextItems, previousId) {
  if (nextItems.length === 0) return null;
  const previousIndex = Math.max(0, previousItems.findIndex(({ id }) => id === previousId));
  const previousPositions = new Map(previousItems.map((item, index) => [item.id, index]));
  return [...nextItems].sort((left, right) => {
    const leftDistance = Math.abs((previousPositions.get(left.id) ?? previousIndex) - previousIndex);
    const rightDistance = Math.abs((previousPositions.get(right.id) ?? previousIndex) - previousIndex);
    return leftDistance - rightDistance || left.id.localeCompare(right.id);
  })[0]?.id ?? nextItems[0].id;
}

function preferredMember(detail, existingId = null) {
  const members = detail?.item?.members ?? [];
  if (members.some(({ id }) => id === existingId)) return existingId;
  return members.find(({ role, available }) => role === 'actual' && available)?.id
    ?? members.find(({ available }) => available)?.id
    ?? members[0]?.id
    ?? null;
}

function withSelection(state, itemId, options = {}) {
  if (itemId === state.selection.itemId && !options.forceHistory) return state;
  const history = options.history === false || state.selection.itemId === null
    ? state.history
    : [...state.history, {
        mode: state.mode,
        itemId: options.historyItemId ?? state.selection.itemId,
        focusKey: options.historyFocusKey ?? null,
      }].slice(-50);
  if (itemId === state.selection.itemId) return { ...state, history };
  const selected = state.accepted.items.find(({ id }) => id === itemId);
  const suiteAnchor = selected
    ? state.query.group === 'technical' ? selected.technicalSuite : selected.primaryFeatureSuite
    : state.suiteAnchor;
  return {
    ...state,
    history,
    suiteAnchor,
    selection: { ...state.selection, itemId, memberId: null },
    detail: null,
    availability: null,
    media: { status: 'idle', itemId, memberId: null, source: null, error: null },
  };
}

export function galleryReducer(state, action) {
  switch (action.type) {
    case 'REQUEST_STARTED': {
      if (!REQUEST_SLOTS.includes(action.slot)) return state;
      return updateRequest(state, action.slot, {
        generation: action.generation,
        semanticKey: action.semanticKey,
        status: 'loading',
        error: null,
      });
    }
    case 'REQUEST_CANCELLED':
      return requestMatches(state, action) ? updateRequest(state, action.slot, { status: 'idle' }) : state;
    case 'REQUEST_FAILED': {
      if (!requestMatches(state, action)) return state;
      let next = updateRequest(state, action.slot, { status: 'error', error: String(action.error ?? 'Request failed.') });
      if (action.slot === 'query' && next.pendingRevision?.applying) {
        next = { ...next, pendingRevision: { ...next.pendingRevision, applying: false } };
      }
      return action.slot === 'media'
        ? { ...next, media: { ...next.media, status: 'error', source: null, error: String(action.error ?? 'Media unavailable.') } }
        : next;
    }
    case 'HEAD_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      const head = requireObject(action.head, 'Gallery descriptor');
      if (typeof head.contentRevision !== 'string' || typeof head.orderRevision !== 'string') throw new TypeError('Gallery descriptor revision is invalid.');
      if (state.accepted.contentRevision && (
        head.contentRevision !== state.accepted.contentRevision
        || head.orderRevision !== state.accepted.orderRevision
        || (head.flagRevision ?? null) !== state.accepted.flagRevision
      )) {
        return {
          ...updateRequest(state, 'head', { status: 'success' }),
          pendingRevision: {
            contentRevision: head.contentRevision,
            flagRevision: head.flagRevision ?? null,
            orderRevision: head.orderRevision,
            head,
            attentionCount: Number.isInteger(action.attentionCount) ? action.attentionCount : 0,
          },
        };
      }
      return {
        ...updateRequest(state, 'head', { status: 'success' }),
        descriptor: head,
        phase: ['waiting', 'live', 'sealed'].includes(head.phase) ? head.phase : state.phase,
      };
    }
    case 'REVISION_AVAILABLE': {
      if (
        action.contentRevision === state.accepted.contentRevision
        && action.orderRevision === state.accepted.orderRevision
        && (action.flagRevision ?? null) === state.accepted.flagRevision
      ) return state;
      return {
        ...state,
        pendingRevision: {
          contentRevision: action.contentRevision,
          flagRevision: action.flagRevision ?? null,
          orderRevision: action.orderRevision,
          head: action.head ?? null,
          attentionCount: Number.isInteger(action.attentionCount) ? action.attentionCount : 0,
        },
      };
    }
    case 'APPLY_PENDING_REVISION':
      return state.pendingRevision ? {
        ...state,
        pendingRevision: { ...state.pendingRevision, applying: true },
      } : state;
    case 'SET_QUERY':
      return { ...state, query: normalizedQuery(action.query), suiteAnchor: action.suiteAnchor ?? state.suiteAnchor };
    case 'QUERY_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      if (action.acceptPending && (
        !state.pendingRevision?.applying
        || action.contentRevision !== state.pendingRevision.contentRevision
        || action.orderRevision !== state.pendingRevision.orderRevision
        || (action.flagRevision ?? null) !== state.pendingRevision.flagRevision
      )) return state;
      const rows = (Array.isArray(action.rows) ? action.rows : []).map(decodeGalleryQueryRow);
      const merged = action.append
        ? [...state.accepted.items, ...rows.filter((row) => !state.accepted.items.some(({ id }) => id === row.id))]
        : rows;
      const revision = action.contentRevision ?? state.accepted.contentRevision;
      const revisionChanged = revision !== state.accepted.contentRevision
        || (action.orderRevision ?? state.accepted.orderRevision) !== state.accepted.orderRevision
        || (action.flagRevision ?? state.accepted.flagRevision) !== state.accepted.flagRevision;
      let itemId = state.selection.itemId;
      let anchor = state.selection.outOfFilterAnchor;
      if (anchor && merged.some(({ id }) => id === anchor) && action.restoreAnchor !== false) {
        itemId = anchor;
        anchor = null;
      } else if (itemId && !merged.some(({ id }) => id === itemId)) {
        anchor = anchor ?? itemId;
        itemId = nearestVisibleItem(state.accepted.items, merged, itemId);
      } else if (!itemId) {
        itemId = merged.some(({ id }) => id === action.preferredItemId)
          ? action.preferredItemId
          : merged[0]?.id ?? null;
      }
      const selectionChanged = itemId !== state.selection.itemId;
      const selectedRow = merged.find(({ id }) => id === itemId);
      const suiteAnchor = selectedRow
        ? action.queryGroup === 'technical' || state.query.group === 'technical'
          ? selectedRow.technicalSuite
          : selectedRow.primaryFeatureSuite
        : state.suiteAnchor;
      return {
        ...updateRequest(state, 'query', { status: 'success' }),
        descriptor: action.acceptPending ? state.pendingRevision?.head ?? state.descriptor : state.descriptor,
        phase: action.phase ?? state.phase,
        accepted: {
          contentRevision: revision,
          flagRevision: action.flagRevision ?? state.accepted.flagRevision,
          orderRevision: action.orderRevision ?? state.accepted.orderRevision,
          items: merged,
          total: Number.isInteger(action.total) ? action.total : merged.length,
          windows: action.append
            ? [...state.accepted.windows, { offset: action.offset ?? state.accepted.items.length, ids: rows.map(({ id }) => id) }]
            : [{ offset: action.offset ?? 0, ids: rows.map(({ id }) => id) }],
          nextCursor: action.nextCursor ?? null,
        },
        selection: { itemId, memberId: selectionChanged ? null : state.selection.memberId, outOfFilterAnchor: anchor },
        suiteAnchor,
        detail: selectionChanged || revisionChanged ? null : state.detail,
        availability: selectionChanged || revisionChanged ? null : state.availability,
        thumbnails: revisionChanged ? {} : state.thumbnails,
        media: selectionChanged || revisionChanged
          ? { status: 'idle', itemId, memberId: null, source: null, error: null }
          : state.media,
        pendingRevision: action.acceptPending ? null : state.pendingRevision,
      };
    }
    case 'SELECT_ITEM': {
      if (!state.accepted.items.some(({ id }) => id === action.itemId)) return state;
      return withSelection(state, action.itemId, action);
    }
    case 'DETAIL_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      const detail = decodeGalleryItemDetail(action.detail);
      if (detail.item.id !== state.selection.itemId) return state;
      const memberId = preferredMember(detail, state.selection.memberId);
      return {
        ...updateRequest(state, 'detail', { status: 'success' }),
        detail,
        availability: detail.availability,
        selection: { ...state.selection, memberId },
        media: { status: 'idle', itemId: detail.item.id, memberId, source: null, error: null },
      };
    }
    case 'AVAILABILITY_SUCCEEDED':
      return requestMatches(state, action)
        ? { ...updateRequest(state, 'availability', { status: 'success' }), availability: action.availability }
        : state;
    case 'SET_MEMBER': {
      if (!state.detail) return state;
      const members = state.detail.item.members;
      const target = typeof action.memberId === 'string'
        ? members.find(({ id }) => id === action.memberId)
        : members[Math.max(0, Math.min(members.length - 1, members.findIndex(({ id }) => id === state.selection.memberId) + action.delta))];
      if (!target || target.id === state.selection.memberId) return state;
      return {
        ...state,
        selection: { ...state.selection, memberId: target.id },
        media: { status: 'idle', itemId: state.selection.itemId, memberId: target.id, source: null, error: null },
      };
    }
    case 'MEDIA_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      const source = trustedResolvedMedia(action.source);
      if (!source) return galleryReducer(state, { ...action, type: 'REQUEST_FAILED', error: 'The media adapter returned an unsafe source.' });
      return {
        ...updateRequest(state, 'media', { status: 'success' }),
        media: { status: 'resolved', itemId: action.itemId, memberId: action.memberId, source, error: null, posterError: null },
      };
    }
    case 'MEDIA_ELEMENT_LOADED':
      return action.itemId === state.selection.itemId && action.memberId === state.selection.memberId && state.media.status !== 'ready'
        ? { ...state, media: { ...state.media, status: 'ready', error: null } }
        : state;
    case 'POSTER_ELEMENT_FAILED':
      return action.itemId === state.selection.itemId && action.memberId === state.selection.memberId && state.media.source?.posterUrl
        ? { ...state, media: {
            ...state.media,
            source: state.media.source ? { ...state.media.source, posterUrl: null } : null,
            posterError: 'The video poster could not be loaded; video playback remains available.',
          } }
        : state;
    case 'MEDIA_ELEMENT_FAILED':
      return action.itemId === state.selection.itemId && action.memberId === state.selection.memberId ? {
        ...state,
        media: {
          status: 'error', itemId: action.itemId, memberId: action.memberId,
          source: null, error: String(action.error ?? 'The selected media could not be loaded.'),
        },
        availability: {
          state: 'tombstone', retryable: true,
          message: String(action.error ?? 'The selected media could not be loaded.'),
        },
      } : state;
    case 'THUMBNAIL_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      const source = trustedResolvedMedia(action.source);
      if (!source) return state;
      return {
        ...updateRequest(state, 'thumbnail', { status: 'success' }),
        thumbnails: Object.fromEntries(Object.entries({ ...state.thumbnails, [action.itemId]: source.url }).slice(-GALLERY_LIMITS.retainedThumbnails)),
      };
    }
    case 'SET_PLAYBACK':
      return action.memberId ? {
        ...state,
        playback: Object.fromEntries(Object.entries({
          ...state.playback,
          [action.memberId]: { time: Math.max(0, Number(action.time) || 0), paused: action.paused !== false },
        }).slice(-GALLERY_LIMITS.retainedPlayback)),
      } : state;
    case 'SET_MODE':
      return ['workbench', 'overview'].includes(action.mode) ? { ...state, mode: action.mode } : state;
    case 'SET_SUITE_ANCHOR':
      return { ...state, suiteAnchor: action.suiteAnchor ?? null };
    case 'OPEN_LAYER': {
      const key = action.focusKey ?? null;
      const focusHistory = key ? [...state.layers.focusHistory, key].slice(-20) : state.layers.focusHistory;
      if (action.layer === 'help') return { ...state, layers: { ...state.layers, help: true, focusHistory } };
      if (action.layer === 'context') return { ...state, layers: { ...state.layers, context: true, focusHistory } };
      if (action.layer === 'responsivePanel') return { ...state, layers: { ...state.layers, responsivePanel: action.panel ?? 'queue', focusHistory } };
      return state;
    }
    case 'CLOSE_LAYER': {
      const focusHistory = state.layers.focusHistory.slice(0, -1);
      if (action.layer === 'help') return { ...state, layers: { ...state.layers, help: false, focusHistory } };
      if (action.layer === 'context') return { ...state, layers: { ...state.layers, context: false, focusHistory } };
      if (action.layer === 'responsivePanel') return { ...state, layers: { ...state.layers, responsivePanel: null, focusHistory } };
      return state;
    }
    case 'FULLSCREEN_CHANGED':
      return { ...state, layers: { ...state.layers, fullscreen: Boolean(action.active) } };
    case 'ESCAPE_LAYER': {
      if (state.layers.fullscreen) return { ...state, layers: { ...state.layers, fullscreen: false } };
      if (state.layers.help) return galleryReducer(state, { type: 'CLOSE_LAYER', layer: 'help' });
      if (state.layers.responsivePanel) return galleryReducer(state, { type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      if (state.layers.context) return galleryReducer(state, { type: 'CLOSE_LAYER', layer: 'context' });
      if (state.mode === 'overview') return { ...state, mode: 'workbench' };
      if (state.history.length > 0) {
        const previous = state.history.at(-1);
        return {
          ...withSelection({ ...state, mode: previous.mode, history: state.history.slice(0, -1) }, previous.itemId, { history: false }),
          history: state.history.slice(0, -1),
        };
      }
      return state;
    }
    case 'SET_CAPABILITY':
      return { ...state, capability: { ...state.capability, ...action.capability } };
    case 'FLAG_SUCCEEDED':
      return requestMatches(state, action)
        ? { ...updateRequest(state, 'flag', { status: 'success' }), pendingRevision: action.pendingRevision ?? state.pendingRevision }
        : state;
    case 'PURGED':
      return { ...state, purged: true, phase: 'purged', capability: { ...state.capability, flagsMutable: false } };
    default:
      return state;
  }
}

export function selectSelectedRow(state) {
  return state.accepted.items.find(({ id }) => id === state.selection.itemId) ?? null;
}

export function selectSelectedMember(state) {
  return state.detail?.item?.members.find(({ id }) => id === state.selection.memberId) ?? null;
}

export function selectSequencePosition(state) {
  const index = state.accepted.items.findIndex(({ id }) => id === state.selection.itemId);
  return { index, ordinal: index < 0 ? 0 : index + 1, total: state.accepted.total };
}

export function selectLocalFilmstrip(state) {
  const index = state.accepted.items.findIndex(({ id }) => id === state.selection.itemId);
  if (index < 0) return [];
  const radius = Math.floor(GALLERY_LIMITS.filmstripItems / 2);
  const start = Math.max(0, Math.min(index - radius, state.accepted.items.length - GALLERY_LIMITS.filmstripItems));
  return state.accepted.items.slice(start, start + GALLERY_LIMITS.filmstripItems);
}

export function selectAsyncState(state) {
  if (state.purged) return { key: 'purged-run', title: 'This run was purged', recovery: 'Return to runs' };
  if (state.requests.head.status === 'error' && !state.accepted.contentRevision) {
    return { key: 'terminal-catalog-error', title: 'The visual evidence index could not be loaded', recovery: 'Retry from a fresh descriptor' };
  }
  if (state.requests.query.status === 'error' && !state.accepted.contentRevision && state.accepted.items.length === 0) {
    return { key: 'terminal-catalog-error', title: 'The visual evidence index could not be loaded', recovery: 'Retry from a fresh descriptor' };
  }
  if (['waiting', 'live'].includes(state.phase) && state.accepted.total === 0 && state.requests.query.status !== 'loading') {
    return { key: 'active-run-waiting', title: 'Waiting for finalized visual evidence', recovery: 'Continue watching' };
  }
  if (state.phase === 'sealed' && (state.descriptor?.primaryCounts?.total ?? state.accepted.total) === 0) {
    return { key: 'sealed-empty', title: 'This run has no eligible visual evidence', recovery: 'Inspect test outcomes or raw files' };
  }
  if ((state.descriptor?.primaryCounts?.total ?? 0) > 0 && state.accepted.total === 0 && state.requests.query.status !== 'loading') {
    return { key: 'zero-filtered-results', title: 'No evidence matches these filters', recovery: 'Clear filters' };
  }
  if (state.requests.query.status === 'error' && state.accepted.items.length > 0) {
    return { key: 'partial-catalog', title: 'Some evidence metadata could not be loaded', recovery: 'Retry this window' };
  }
  if (state.availability?.state === 'tombstone' || state.media.status === 'error') {
    return { key: 'selected-blob-unavailable', title: 'The selected evidence is unavailable', recovery: 'Retry this member' };
  }
  if (state.requests.query.status === 'loading' && state.accepted.items.length > 0) {
    return { key: 'partial-catalog', title: 'Current evidence is usable while more metadata loads', recovery: null };
  }
  if (state.phase === 'loading' || state.requests.head.status === 'loading' || state.requests.query.status === 'loading') {
    return { key: 'loading', title: 'Loading visual evidence', recovery: null };
  }
  return { key: 'ready', title: 'Visual evidence ready', recovery: null };
}

function trustedResolvedMedia(value) {
  if (!value || value.validatedByAdapter !== true || typeof value.url !== 'string') return null;
  const safe = isContainedRelativeMediaUrl(value.url);
  if (!safe) return null;
  return Object.freeze({
    validatedByAdapter: true,
    url: value.url,
    posterUrl: typeof value.posterUrl === 'string' && value.posterUrl !== value.url
      ? trustedResolvedMedia({ validatedByAdapter: true, url: value.posterUrl })?.url ?? null
      : null,
  });
}

function isContainedRelativeMediaUrl(value) {
  if (
    typeof value !== 'string'
    || value === ''
    || value.startsWith('//')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || /[\u0000-\u001f\u007f]/.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) return false;
  const portalArtifact = value.startsWith('/artifacts/');
  const archiveEvidence = value.startsWith('evidence/') || value.startsWith('./evidence/');
  if (!portalArtifact && !archiveEvidence) return false;
  const relative = value.startsWith('/') ? value.slice(1) : value.replace(/^\.\//, '');
  if (!relative) return false;
  for (const encoded of relative.split('/')) {
    if (!encoded) return false;
    let segment;
    try { segment = decodeURIComponent(encoded); } catch { return false; }
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || /[\u0000-\u001f\u007f]/.test(segment)) return false;
  }
  return true;
}

export function shouldSuppressGalleryShortcut(event) {
  if (!event || event.defaultPrevented || event.isComposing || event.repeat && event.key === '?') return true;
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  const target = event.target;
  const tag = String(target?.tagName ?? '').toLowerCase();
  if (['input', 'textarea', 'select', 'option', 'video', 'audio'].includes(tag)) return true;
  if (target?.isContentEditable) return true;
  const role = target?.getAttribute?.('role');
  if (['textbox', 'combobox', 'slider', 'spinbutton'].includes(role)) return true;
  if (target?.closest?.('dialog,[role="dialog"],[data-gallery-shortcuts="owned"]')) return true;
  return Boolean(event.shiftKey && !['?', '[', ']'].includes(event.key));
}

export function selectNavigationTarget(state, direction, byTest = false) {
  const items = state.accepted.items;
  const index = items.findIndex(({ id }) => id === state.selection.itemId);
  if (index < 0) return null;
  if (!byTest) return items[index + direction]?.id ?? null;
  const currentGroup = items[index].testGroupId;
  const localOrdinal = items.slice(0, index).filter(({ testGroupId }) => testGroupId === currentGroup).length;
  let cursor = index + direction;
  while (cursor >= 0 && cursor < items.length && items[cursor].testGroupId === currentGroup) cursor += direction;
  if (cursor < 0 || cursor >= items.length) return null;
  const destinationGroup = items[cursor].testGroupId;
  const destination = items.filter(({ testGroupId }) => testGroupId === destinationGroup);
  return destination[Math.min(localOrdinal, destination.length - 1)]?.id ?? null;
}

function element(doc, tag, className, text = null) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}

function bdi(doc, text) {
  const node = element(doc, 'bdi', null, text ?? 'Not recorded');
  node.dir = 'auto';
  return node;
}

function button(doc, label, action, onAction) {
  const node = element(doc, 'button', 'gallery-button', label);
  node.type = 'button';
  node.dataset.galleryAction = action;
  node.addEventListener('click', onAction);
  return node;
}

function clearVideo(video) {
  if (!video) return;
  try { video.pause(); } catch { /* A detached fake or browser video may not implement pause. */ }
  video.removeAttribute('src');
  try { video.load(); } catch { /* Clearing the source is the authoritative cancellation. */ }
}

function renderRegionsForAction(action) {
  const type = action.type;
  if (type === 'SET_PLAYBACK') return [];
  if (type.startsWith('REQUEST_')) {
    if (action.slot === 'thumbnail') return [];
    if (action.slot === 'media') return ['status', 'viewer'];
    if (action.slot === 'detail' || action.slot === 'availability') return ['status', 'context'];
    if (action.slot === 'flag') return ['status', 'context'];
    return ['status', 'controls', 'queue', 'viewer', 'filmstrip', 'context', 'overview'];
  }
  if (type === 'THUMBNAIL_SUCCEEDED') return ['filmstrip', 'overview'];
  if (type === 'QUERY_SUCCEEDED' && !action.acceptPending) {
    // SET_QUERY already rendered the chosen controls. Keep those elements
    // mounted while the result arrives so a reviewer does not lose focus (or
    // an immediately-following Escape key) to an unrelated data refresh.
    return ['status', 'queue', 'viewer', 'filmstrip', 'context', 'overview'];
  }
  if (type === 'MEDIA_SUCCEEDED' || type === 'AVAILABILITY_SUCCEEDED') return ['status', 'viewer'];
  if (type === 'MEDIA_ELEMENT_LOADED' || type === 'MEDIA_ELEMENT_FAILED' || type === 'POSTER_ELEMENT_FAILED') return ['status', 'viewer'];
  if (type === 'DETAIL_SUCCEEDED' || type === 'SET_MEMBER') return ['status', 'viewer', 'context'];
  if (type === 'OPEN_LAYER' || type === 'CLOSE_LAYER' || type === 'FULLSCREEN_CHANGED' || type === 'ESCAPE_LAYER') {
    // Layer and fullscreen state do not change the selected media. Keeping the
    // viewer DOM mounted preserves video playback, avoids duplicate range
    // requests, and prevents a help/context action from resetting currentTime.
    return ['controls', 'queue', 'context', 'overview', 'help'];
  }
  if (type === 'SET_MODE') return ['controls', 'queue', 'viewer', 'filmstrip', 'context', 'overview'];
  return ['status', 'controls', 'queue', 'viewer', 'filmstrip', 'context', 'overview', 'help'];
}

export function createGalleryWorkbench(root, options = {}) {
  if (!root?.ownerDocument) throw new TypeError('A gallery root element is required.');
  const doc = root.ownerDocument;
  const adapter = options.adapter ?? {};
  const scheduler = options.scheduler ?? ((task) => queueMicrotask(task));
  const announceSink = typeof options.announce === 'function' ? options.announce : () => {};
  const focusByKey = typeof options.focusByKey === 'function'
    ? options.focusByKey
    : (key) => root.querySelector?.(`[data-focus-key="${key}"]`)?.focus?.();
  const viewportMode = typeof options.viewportMode === 'function'
    ? options.viewportMode
    : () => {
        const width = root.ownerDocument.defaultView?.innerWidth ?? 1_024;
        return width < 768 ? 'mobile' : width < 1_024 ? 'tablet' : 'desktop';
      };
  let state = createInitialGalleryState(options.initialState);
  let renderQueued = false;
  let activeVideo = null;
  let destroyed = false;
  let lastAnnouncement = '';
  const dirtyRegions = new Set();
  const thumbnailQueue = [];
  let thumbnailBusy = false;
  let firstUsableEmitted = false;
  let thumbnailResolutionEnabled = false;
  let activeOverviewObserver = null;
  let pendingFocusRestoreKey = null;
  const subscribers = new Set();
  const controllers = new Map();
  const generations = Object.fromEntries(REQUEST_SLOTS.map((slot) => [slot, 0]));

  const shell = element(doc, 'section', 'gallery-shell');
  shell.tabIndex = 0;
  shell.dataset.galleryRegion = 'root';
  shell.dataset.focusKey = 'gallery-root';
  const statusRegion = element(doc, 'header', 'gallery-status');
  statusRegion.setAttribute('role', 'status');
  statusRegion.setAttribute('aria-live', 'polite');
  statusRegion.setAttribute('aria-atomic', 'true');
  const controlsRegion = element(doc, 'nav', 'gallery-controls');
  controlsRegion.setAttribute('aria-label', 'Visual evidence controls');
  const bodyRegion = element(doc, 'div', 'gallery-body');
  const queueRegion = element(doc, 'aside', 'gallery-queue');
  queueRegion.dataset.galleryRegion = 'queue';
  const viewerColumn = element(doc, 'main', 'gallery-viewer-column');
  const viewerRegion = element(doc, 'div', 'gallery-viewer');
  viewerRegion.dataset.galleryRegion = 'viewer';
  viewerRegion.dataset.focusKey = 'gallery-viewer';
  viewerRegion.tabIndex = 0;
  const filmstripRegion = element(doc, 'div', 'gallery-filmstrip');
  const contextRegion = element(doc, 'aside', 'gallery-context');
  contextRegion.dataset.galleryRegion = 'context';
  const overviewRegion = element(doc, 'main', 'gallery-overview');
  overviewRegion.dataset.galleryRegion = 'overview';
  viewerColumn.append(viewerRegion, filmstripRegion);
  bodyRegion.append(queueRegion, viewerColumn, contextRegion, overviewRegion);
  shell.append(statusRegion, controlsRegion, bodyRegion);
  root.replaceChildren(shell);

  function announce(message) {
    const bounded = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, GALLERY_LIMITS.announcementCharacters);
    if (!bounded || bounded === lastAnnouncement) return;
    lastAnnouncement = bounded;
    announceSink(bounded);
  }

  function dispatch(action) {
    const previousAsyncState = selectAsyncState(state);
    const next = galleryReducer(state, action);
    if (next === state) return state;
    const activeFocusKey = doc.activeElement && shell.contains(doc.activeElement)
      ? doc.activeElement.dataset?.focusKey ?? null
      : null;
    if (activeFocusKey) pendingFocusRestoreKey = activeFocusKey;
    state = next;
    const nextAsyncState = selectAsyncState(state);
    if (nextAsyncState.key !== previousAsyncState.key) announce(nextAsyncState.title);
    for (const subscriber of subscribers) subscriber(state, action);
    for (const region of renderRegionsForAction(action)) dirtyRegions.add(region);
    if (!renderQueued) {
      renderQueued = true;
      scheduler(() => {
        renderQueued = false;
        if (!destroyed) {
          const targets = new Set(dirtyRegions);
          dirtyRegions.clear();
          render(targets);
          if (pendingFocusRestoreKey) {
            const focusKey = pendingFocusRestoreKey;
            pendingFocusRestoreKey = null;
            focusByKey(focusKey);
          }
        }
      });
    }
    return state;
  }

  function abort(slot) {
    const existing = controllers.get(slot);
    if (!existing) return;
    existing.controller.abort();
    dispatch({ type: 'REQUEST_CANCELLED', slot, generation: existing.generation, semanticKey: existing.semanticKey });
    controllers.delete(slot);
  }

  async function request(slot, semanticKey, work, success) {
    abort(slot);
    const generation = ++generations[slot];
    const controller = new AbortController();
    controllers.set(slot, { controller, generation, semanticKey });
    dispatch({ type: 'REQUEST_STARTED', slot, generation, semanticKey });
    try {
      const value = await work(controller.signal);
      if (controller.signal.aborted) return null;
      dispatch(success(value, generation, semanticKey));
      return value;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return null;
      if (error?.status === 410 || error?.code === 'GALLERY_RUN_PURGED') dispatch({ type: 'PURGED' });
      else dispatch({ type: 'REQUEST_FAILED', slot, generation, semanticKey, error: error?.message ?? error });
      return null;
    } finally {
      if (controllers.get(slot)?.generation === generation) controllers.delete(slot);
    }
  }

  async function loadHead() {
    if (typeof adapter.loadHead !== 'function') return null;
    return request('head', 'head', (signal) => adapter.loadHead({ signal }), (head, generation, semanticKey) => ({
      type: 'HEAD_SUCCEEDED', slot: 'head', generation, semanticKey, head,
    }));
  }

  async function loadSequence({
    append = false,
    restoreAnchor = true,
    revision = null,
    orderRevision = null,
    flagRevision = null,
    acceptPending = false,
    preferredItemId = null,
  } = {}) {
    if (typeof adapter.loadItems !== 'function') return null;
    const anchorItemId = append ? null : preferredItemId
      ?? (restoreAnchor ? state.selection.outOfFilterAnchor ?? state.selection.itemId : null);
    const key = `${queryKey(state.query)}|${revision ?? state.accepted.contentRevision ?? 'head'}|${orderRevision ?? state.accepted.orderRevision ?? ''}|${flagRevision ?? state.accepted.flagRevision ?? ''}|${append ? state.accepted.nextCursor ?? '' : ''}`;
    const result = await request('query', key, (signal) => adapter.loadItems({
      query: state.query,
      contentRevision: revision ?? state.accepted.contentRevision,
      orderRevision: orderRevision ?? state.accepted.orderRevision,
      flagRevision: flagRevision ?? state.accepted.flagRevision,
      cursor: append ? state.accepted.nextCursor : null,
      limit: GALLERY_LIMITS.pageRows,
      anchorItemId,
      signal,
    }), (value, generation, semanticKey) => ({
      type: 'QUERY_SUCCEEDED',
      slot: 'query',
      generation,
      semanticKey,
      rows: value.items ?? value.rows,
      total: value.total,
      offset: value.offset,
      nextCursor: value.nextCursor,
      contentRevision: value.contentRevision ?? revision,
      orderRevision: value.orderRevision,
      flagRevision: value.flagRevision ?? flagRevision,
      phase: value.phase,
      append,
      restoreAnchor,
      acceptPending,
      preferredItemId,
    }));
    if (result && state.selection.itemId && !append) await loadSelected();
    return result;
  }

  async function loadSelected() {
    abort('detail');
    abort('availability');
    abort('media');
    const itemId = state.selection.itemId;
    if (!itemId || typeof adapter.loadItem !== 'function') return null;
    const key = `${state.accepted.contentRevision}|${itemId}`;
    const result = await request('detail', key, (signal) => adapter.loadItem({
      itemId,
      contentRevision: state.accepted.contentRevision,
      signal,
    }), (detail, generation, semanticKey) => ({
      type: 'DETAIL_SUCCEEDED', slot: 'detail', generation, semanticKey, itemId, contentRevision: state.accepted.contentRevision, detail,
    }));
    if (result && state.selection.itemId === itemId) await resolveSelectedMedia();
    return result;
  }

  async function resolveSelectedMedia() {
    abort('media');
    const itemId = state.selection.itemId;
    const memberId = state.selection.memberId;
    if (!itemId || !memberId || !state.detail || typeof adapter.resolveMedia !== 'function') return null;
    const media = state.detail.media.find((entry) => entry.memberId === memberId);
    const key = `${state.accepted.contentRevision}|${itemId}|${memberId}`;
    return request('media', key, (signal) => adapter.resolveMedia({
      item: state.detail.item,
      member: state.detail.item.members.find(({ id }) => id === memberId),
      mediaReference: media?.adapterReference ?? null,
      posterReference: media?.adapterPosterReference ?? null,
      signal,
    }), (source, generation, semanticKey) => ({
      type: 'MEDIA_SUCCEEDED', slot: 'media', generation, semanticKey, itemId, memberId,
      contentRevision: state.accepted.contentRevision, source,
    }));
  }

  async function probeSelectedAvailability() {
    const itemId = state.selection.itemId;
    if (!itemId || typeof adapter.loadAvailability !== 'function') return null;
    const key = `${state.accepted.contentRevision}|${state.accepted.orderRevision}|${state.accepted.flagRevision}|${itemId}`;
    return request('availability', key, (signal) => adapter.loadAvailability({
      itemId,
      contentRevision: state.accepted.contentRevision,
      orderRevision: state.accepted.orderRevision,
      flagRevision: state.accepted.flagRevision,
      signal,
    }), (availability, generation, semanticKey) => ({
      type: 'AVAILABILITY_SUCCEEDED', slot: 'availability', generation, semanticKey,
      itemId, contentRevision: state.accepted.contentRevision, availability,
    }));
  }

  async function retrySelectedMedia() {
    const availability = await probeSelectedAvailability();
    if (!availability || availability.state === 'tombstone') return availability;
    return loadSelected();
  }

  async function resolveThumbnailNow(row) {
    if (!row || state.thumbnails[row.id] || row.kind !== 'image' || typeof adapter.resolveThumbnail !== 'function') return null;
    const key = `${state.accepted.contentRevision}|thumb|${row.id}`;
    return request('thumbnail', key, (signal) => adapter.resolveThumbnail({ row, signal }), (source, generation, semanticKey) => ({
      type: 'THUMBNAIL_SUCCEEDED', slot: 'thumbnail', generation, semanticKey, itemId: row.id,
      contentRevision: state.accepted.contentRevision, source,
    }));
  }

  function resolveThumbnail(row) {
    if (!row || state.thumbnails[row.id] || thumbnailQueue.some(({ id }) => id === row.id)) return;
    thumbnailQueue.push(row);
    if (thumbnailBusy) return;
    thumbnailBusy = true;
    void (async () => {
      while (thumbnailQueue.length > 0 && !destroyed) await resolveThumbnailNow(thumbnailQueue.shift());
      thumbnailBusy = false;
    })();
  }

  async function initialize() {
    const head = await loadHead();
    if (!head) return;
    if (head.phase === 'waiting') return;
    await loadSequence({ revision: head.contentRevision });
  }

  async function setQuery(next) {
    dispatch({ type: 'SET_QUERY', query: { ...state.query, ...next } });
    await loadSequence({ restoreAnchor: true });
  }

  async function selectItem(itemId, options = {}) {
    abort('detail');
    abort('availability');
    abort('media');
    dispatch({ type: 'SELECT_ITEM', itemId, ...options });
    const selected = selectSelectedRow(state);
    const position = selectSequencePosition(state);
    if (selected) announce(`${selected.kind === 'video' ? 'Video' : 'Photo'} ${position.ordinal} of ${position.total}. ${selected.title}. ${selected.status}.`);
    await loadSelected();
  }

  async function selectMember(delta) {
    abort('media');
    const prior = state.selection.memberId;
    dispatch({ type: 'SET_MEMBER', delta });
    if (state.selection.memberId === prior) {
      announce('You reached the end of this comparison.');
      return;
    }
    const member = selectSelectedMember(state);
    if (member) announce(`${member.role} comparison member selected.`);
    await resolveSelectedMedia();
  }

  async function applyPendingRevision() {
    const pending = state.pendingRevision;
    if (!pending) return;
    dispatch({ type: 'APPLY_PENDING_REVISION' });
    await loadSequence({
      revision: pending.contentRevision,
      orderRevision: pending.orderRevision,
      flagRevision: pending.flagRevision,
      acceptPending: true,
    });
  }

  async function mutateFlag(transition) {
    if (!state.capability.flagsMutable || typeof adapter.mutateFlag !== 'function') {
      announce('Reviewer flags are read-only in this gallery.');
      return null;
    }
    const itemId = state.selection.itemId;
    const key = `${itemId}|${transition.action}|${transition.idempotencyKey ?? ''}`;
    return request('flag', key, (signal) => adapter.mutateFlag({ ...transition, itemId, signal }), (result, generation, semanticKey) => ({
      type: 'FLAG_SUCCEEDED', slot: 'flag', generation, semanticKey, itemId, result, pendingRevision: result.pendingRevision,
    }));
  }

  async function navigate(direction, byTest = false) {
    let itemId = selectNavigationTarget(state, direction, byTest);
    if (!itemId && direction > 0 && state.accepted.nextCursor) {
      await loadSequence({ append: true, restoreAnchor: false });
      itemId = selectNavigationTarget(state, direction, byTest);
    }
    if (!itemId) {
      announce(byTest ? 'No more test groups in that direction.' : 'You reached the end of this evidence sequence.');
      return;
    }
    await selectItem(itemId);
  }

  function restoreFocus(key = state.layers.focusHistory.at(-1)) {
    if (key) scheduler(() => focusByKey(key));
  }

  async function toggleFullscreen() {
    const fullscreen = options.fullscreen;
    if (!fullscreen) {
      announce('Fullscreen is not available in this viewer.');
      return;
    }
    try {
      if (fullscreen.isActive?.()) await fullscreen.exit();
      else await fullscreen.enter(viewerRegion);
      const active = Boolean(fullscreen.isActive?.());
      dispatch({ type: 'FULLSCREEN_CHANGED', active });
      announce(active ? 'Viewer entered fullscreen.' : 'Viewer left fullscreen.');
    } catch (error) {
      dispatch({ type: 'FULLSCREEN_CHANGED', active: Boolean(fullscreen.isActive?.()) });
      announce(`Fullscreen did not change. ${error?.message ?? ''}`);
    }
  }

  function unwindEscape() {
    const was = state;
    if (was.layers.fullscreen && options.fullscreen?.isActive?.()) {
      void toggleFullscreen();
      return;
    }
    dispatch({ type: 'ESCAPE_LAYER' });
    if (was.layers.help || was.layers.responsivePanel || was.layers.context) restoreFocus(was.layers.focusHistory.at(-1));
    else if (was.mode !== 'overview' && was.history.length > 0) restoreFocus(was.history.at(-1)?.focusKey);
  }

  function onKeydown(event) {
    if (shouldSuppressGalleryShortcut(event)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    let handled = true;
    if (key === GALLERY_KEYS.previousItem) void navigate(-1, false);
    else if (key === GALLERY_KEYS.nextItem) void navigate(1, false);
    else if (key === GALLERY_KEYS.previousTest) void navigate(-1, true);
    else if (key === GALLERY_KEYS.nextTest) void navigate(1, true);
    else if (event.key === GALLERY_KEYS.previousMember) void selectMember(-1);
    else if (event.key === GALLERY_KEYS.nextMember) void selectMember(1);
    else if (event.key === GALLERY_KEYS.playPause) {
      if (state.detail?.item.kind !== 'video' || !viewerRegion.contains(event.target) || event.target === activeVideo) handled = false;
      else if (activeVideo) {
        if (activeVideo.paused) void activeVideo.play(); else activeVideo.pause();
      }
    } else if (key === GALLERY_KEYS.context) {
      if (state.layers.context) {
        dispatch({ type: 'CLOSE_LAYER', layer: 'context' });
        restoreFocus();
      } else dispatch({ type: 'OPEN_LAYER', layer: 'context', focusKey: event.target?.dataset?.focusKey ?? 'context-toggle' });
    } else if (key === GALLERY_KEYS.fullscreen) void toggleFullscreen();
    else if (key === GALLERY_KEYS.escape) unwindEscape();
    else if (event.key === GALLERY_KEYS.help) dispatch({ type: 'OPEN_LAYER', layer: 'help', focusKey: event.target?.dataset?.focusKey ?? 'gallery-root' });
    else handled = false;
    if (handled) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
  }

  shell.addEventListener('keydown', onKeydown);
  let renderedViewportMode = viewportMode();
  function onViewportResize() {
    const nextViewportMode = viewportMode();
    if (nextViewportMode === renderedViewportMode) return;
    renderedViewportMode = nextViewportMode;
    if (nextViewportMode === 'desktop' && state.layers.responsivePanel) {
      dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      return;
    }
    render(new Set(['controls', 'queue', 'context', 'overview']));
  }
  doc.defaultView?.addEventListener?.('resize', onViewportResize);

  function renderStatus() {
    const asyncState = selectAsyncState(state);
    const position = selectSequencePosition(state);
    statusRegion.replaceChildren();
    const copy = element(doc, 'div', 'gallery-status-copy');
    const title = element(doc, 'strong', null, asyncState.title);
    const row = selectSelectedRow(state);
    const suite = row ? (state.query.group === 'technical' ? row.technicalSuite : row.primaryFeatureSuite) : null;
    const suites = [...new Set(state.accepted.items.map((item) => (
      state.query.group === 'technical' ? item.technicalSuite : item.primaryFeatureSuite
    )).filter(Boolean))];
    const suitePosition = suite ? `${Math.max(0, suites.indexOf(suite)) + 1} of ${suites.length}` : 'not grouped';
    const count = element(doc, 'span', null, `${position.ordinal} of ${position.total}${row ? ` · ${row.kind} · ${row.status} · suite ${suitePosition}` : ''}`);
    copy.append(title, count);
    statusRegion.append(copy);
    if (state.pendingRevision) {
      const notice = element(doc, 'div', 'gallery-revision-notice');
      notice.append(
        bdi(doc, `${state.pendingRevision.attentionCount} new attention item${state.pendingRevision.attentionCount === 1 ? '' : 's'} available.`),
        button(doc, 'Apply updated order', 'apply-revision', () => void applyPendingRevision()),
      );
      statusRegion.append(notice);
    }
    if (asyncState.recovery && asyncState.key !== 'ready') {
      statusRegion.append(button(doc, asyncState.recovery, 'recover', () => {
        if (asyncState.key === 'zero-filtered-results') void setQuery(EMPTY_QUERY);
        else if (asyncState.key === 'selected-blob-unavailable') void retrySelectedMedia();
        else if (!state.purged) void initialize();
      }));
    }
  }

  function renderControls() {
    const compact = viewportMode() !== 'desktop';
    controlsRegion.replaceChildren(
      button(doc, state.mode === 'workbench' ? 'Overview' : 'Workbench', 'toggle-mode', () => dispatch({
        type: 'SET_MODE', mode: state.mode === 'workbench' ? 'overview' : 'workbench',
      })),
      button(doc, 'Test queue', 'queue-panel', () => {
        if (!compact) return queueRegion.focus?.();
        dispatch({ type: 'OPEN_LAYER', layer: 'responsivePanel', panel: 'queue', focusKey: 'queue-toggle' });
        scheduler(() => focusByKey('queue-heading'));
      }),
      button(doc, 'Previous', 'previous', () => navigate(-1)),
      button(doc, 'Next', 'next', () => navigate(1)),
      button(doc, state.layers.context ? 'Test context' : 'Show context', 'context', () => {
        if (compact) {
          if (!state.layers.context) dispatch({ type: 'OPEN_LAYER', layer: 'context', focusKey: 'context-toggle' });
          dispatch({ type: 'OPEN_LAYER', layer: 'responsivePanel', panel: 'context', focusKey: 'context-toggle' });
          scheduler(() => focusByKey('context-heading'));
        } else dispatch({ type: state.layers.context ? 'CLOSE_LAYER' : 'OPEN_LAYER', layer: 'context', focusKey: 'context-toggle' });
      }),
      button(doc, 'Shortcuts', 'help', () => dispatch({ type: 'OPEN_LAYER', layer: 'help', focusKey: 'help-toggle' })),
      button(doc, 'Filters', 'filters-panel', () => {
        if (!compact) return focusByKey('gallery-search');
        dispatch({ type: 'OPEN_LAYER', layer: 'responsivePanel', panel: 'filters', focusKey: 'filters-toggle' });
        scheduler(() => focusByKey('gallery-search'));
      }),
      button(doc, 'Previous comparison', 'previous-member', () => void selectMember(-1)),
      button(doc, 'Next comparison', 'next-member', () => void selectMember(1)),
      button(doc, state.layers.fullscreen ? 'Leave fullscreen' : 'Fullscreen', 'fullscreen', () => void toggleFullscreen()),
    );
    controlsRegion.children?.[1]?.setAttribute?.('data-focus-key', 'queue-toggle');
    controlsRegion.children?.[4]?.setAttribute?.('data-focus-key', 'context-toggle');
    controlsRegion.children?.[5]?.setAttribute?.('data-focus-key', 'help-toggle');
    controlsRegion.children?.[6]?.setAttribute?.('data-focus-key', 'filters-toggle');
    const filters = element(doc, 'div', 'gallery-filters');
    const facetValues = state.descriptor?.facets ?? {};
    const filterSpecs = [
      ['Media', 'kinds', [['', 'Photos and videos'], ['image', 'Photos'], ['video', 'Videos']]],
      ['Status', 'statuses', (facetValues.statuses ?? []).map((value) => [value, value])],
      ['Environment', 'environments', (facetValues.environments ?? []).map((value) => [value, value])],
      ['Feature suite', 'featureSuites', (facetValues.featureSuites ?? []).map((value) => [value, value])],
      ['Technical suite', 'technicalSuites', (facetValues.technicalSuites ?? []).map((value) => [value, value])],
      ['Browser or device', 'targets', (facetValues.targets ?? []).map((value) => [value, value])],
      ['Reviewer flag', 'flagStates', (facetValues.flagStates ?? []).map((value) => [value, value])],
    ];
    for (const [labelText, key, choices] of filterSpecs) {
      const label = element(doc, 'label', 'gallery-filter');
      label.append(element(doc, 'span', null, labelText));
      const select = element(doc, 'select');
      select.dataset.queryKey = key;
      select.dataset.focusKey = `filter-${key}`;
      const all = element(doc, 'option', null, key === 'kinds' ? choices[0][1] : `All ${labelText.toLowerCase()}`);
      all.value = '';
      select.append(all);
      const start = key === 'kinds' ? choices.slice(1) : choices;
      for (const [value, copy] of start.slice(0, GALLERY_LIMITS.facetOptions)) {
        const option = element(doc, 'option', null);
        option.value = value;
        option.textContent = copy;
        option.selected = state.query[key]?.includes(value) ?? false;
        select.append(option);
      }
      select.value = state.query[key]?.[0] ?? '';
      select.addEventListener('change', () => void setQuery({ [key]: select.value ? [select.value] : [] }));
      label.append(select);
      filters.append(label);
    }
    const groupLabel = element(doc, 'label', 'gallery-filter');
    groupLabel.append(element(doc, 'span', null, 'Group by'));
    const groupSelect = element(doc, 'select');
    for (const [value, copy] of [['feature', 'Feature suite'], ['technical', 'Technical suite'], ['none', 'No grouping']]) {
      const option = element(doc, 'option', null, copy);
      option.value = value;
      option.selected = state.query.group === value;
      groupSelect.append(option);
    }
    groupSelect.value = state.query.group;
    groupSelect.dataset.focusKey = 'gallery-group';
    groupSelect.addEventListener('change', () => void setQuery({ group: groupSelect.value }));
    groupLabel.append(groupSelect);
    filters.append(groupLabel);
    const sortLabel = element(doc, 'label', 'gallery-filter');
    sortLabel.append(element(doc, 'span', null, 'Sort'));
    const sortSelect = element(doc, 'select');
    for (const [value, copy] of [
      ['attention', 'Needs attention'], ['feature', 'Feature suite'], ['technical', 'Technical suite'],
      ['audit', 'Audit catalog'], ['capture-time', 'Capture time'],
    ]) {
      const option = element(doc, 'option', null, copy);
      option.value = value;
      option.selected = state.query.sort === value;
      sortSelect.append(option);
    }
    sortSelect.value = state.query.sort;
    sortSelect.dataset.focusKey = 'gallery-sort';
    sortSelect.addEventListener('change', () => void setQuery({ sort: sortSelect.value }));
    sortLabel.append(sortSelect);
    filters.append(sortLabel);
    const searchLabel = element(doc, 'label', 'gallery-filter gallery-search');
    searchLabel.append(element(doc, 'span', null, 'Search tests'));
    const search = element(doc, 'input');
    search.type = 'search';
    search.dataset.focusKey = 'gallery-search';
    search.value = state.query.search;
    search.maxLength = 1_200;
    search.addEventListener('change', () => void setQuery({ search: search.value }));
    searchLabel.append(search);
    filters.append(searchLabel);
    filters.append(button(doc, 'Clear filters', 'clear-filters', () => void setQuery({
      ...EMPTY_QUERY,
      group: state.query.group,
      sort: state.query.sort,
    })));
    if (compact) filters.append(button(doc, 'Close filters', 'close-filters', () => {
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      restoreFocus(focusKey);
    }));
    controlsRegion.append(filters);
  }

  function renderQueue() {
    queueRegion.replaceChildren();
    queueRegion.hidden = state.mode !== 'workbench';
    viewerColumn.hidden = state.mode !== 'workbench';
    if (state.mode !== 'workbench') return;
    const heading = element(doc, 'h2', null, state.query.group === 'technical' ? 'Technical test queue' : 'Feature test queue');
    heading.tabIndex = -1;
    heading.dataset.focusKey = 'queue-heading';
    queueRegion.append(heading);
    if (viewportMode() !== 'desktop') queueRegion.append(button(doc, 'Close test queue', 'close-queue', () => {
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      restoreFocus(focusKey);
    }));
    const selectedIndex = Math.max(0, state.accepted.items.findIndex(({ id }) => id === state.selection.itemId));
    const queueStart = Math.max(0, Math.min(
      selectedIndex - Math.floor(GALLERY_LIMITS.queueItems / 2),
      state.accepted.items.length - GALLERY_LIMITS.queueItems,
    ));
    const items = state.accepted.items.slice(queueStart, queueStart + GALLERY_LIMITS.queueItems);
    let priorSuite = null;
    let priorGroup = null;
    for (const row of items) {
      const suite = state.query.group === 'technical' ? row.technicalSuite : state.query.group === 'none' ? null : row.primaryFeatureSuite;
      if (suite !== priorSuite) {
        const suiteHeading = element(doc, 'h3', 'gallery-suite-label');
        suiteHeading.append(bdi(doc, suite ?? 'Ungrouped evidence'));
        queueRegion.append(suiteHeading);
        priorSuite = suite;
        priorGroup = null;
      }
      if (row.testGroupId !== priorGroup) {
        const label = element(doc, 'h4', 'gallery-test-label');
        label.append(bdi(doc, row.testLabel));
        queueRegion.append(label);
        priorGroup = row.testGroupId;
      }
      const choice = button(doc, `${row.kind === 'video' ? 'Video' : 'Photo'} · ${row.status}`, 'select-item', () => void selectItem(row.id));
      choice.dataset.itemId = row.id;
      choice.dataset.focusKey = `queue-${row.id}`;
      choice.setAttribute('aria-current', row.id === state.selection.itemId ? 'true' : 'false');
      choice.addEventListener('click', () => {
        if (state.layers.responsivePanel === 'queue') dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      });
      queueRegion.append(choice);
    }
  }

  function renderViewer() {
    clearVideo(activeVideo);
    activeVideo = null;
    viewerRegion.replaceChildren();
    const row = selectSelectedRow(state);
    if (!row) {
      viewerRegion.append(element(doc, 'p', 'gallery-empty', selectAsyncState(state).title));
      return;
    }
    const title = element(doc, 'h2', null);
    title.append(bdi(doc, row.title));
    viewerRegion.append(title);
    if (state.media.status === 'loading') viewerRegion.append(element(doc, 'div', 'gallery-loader', 'Loading selected evidence…'));
    else if (state.media.status === 'error' || state.availability?.state === 'tombstone') {
      const unavailable = element(doc, 'section', 'gallery-media-error');
      unavailable.append(
        element(doc, 'strong', null, 'Evidence unavailable'),
        bdi(doc, state.media.error ?? state.availability?.message ?? 'The test context remains available.'),
        button(doc, 'Retry member', 'retry-media', () => void retrySelectedMedia()),
        button(doc, 'Skip to next', 'skip-media', () => void navigate(1)),
      );
      viewerRegion.append(unavailable);
    } else if (['resolved', 'ready'].includes(state.media.status) && state.media.source) {
      const selectedItemId = state.selection.itemId;
      const selectedMemberId = state.selection.memberId;
      const reportMediaFailure = (copy) => dispatch({
        type: 'MEDIA_ELEMENT_FAILED', itemId: selectedItemId, memberId: selectedMemberId, error: copy,
      });
      if (row.kind === 'video') {
        if (state.media.source.posterUrl) {
          const posterProbe = element(doc, 'img', 'gallery-video-poster-probe');
          posterProbe.alt = '';
          posterProbe.hidden = true;
          posterProbe.src = state.media.source.posterUrl;
          posterProbe.addEventListener('error', () => dispatch({
            type: 'POSTER_ELEMENT_FAILED', itemId: selectedItemId, memberId: selectedMemberId,
          }));
          viewerRegion.append(posterProbe);
        }
        const video = element(doc, 'video', 'gallery-selected-video');
        video.controls = true;
        video.preload = 'metadata';
        video.src = state.media.source.url;
        if (state.media.source.posterUrl) video.poster = state.media.source.posterUrl;
        const playback = state.playback[state.selection.memberId] ?? { time: 0, paused: true };
        video.currentTime = playback.time;
        video.addEventListener('loadedmetadata', () => dispatch({
          type: 'MEDIA_ELEMENT_LOADED', itemId: selectedItemId, memberId: selectedMemberId,
        }));
        video.addEventListener('timeupdate', () => dispatch({
          type: 'SET_PLAYBACK', memberId: selectedMemberId, time: video.currentTime, paused: video.paused,
        }));
        video.addEventListener('error', () => reportMediaFailure('The selected video or byte range could not be loaded.'));
        activeVideo = video;
        viewerRegion.append(video);
      } else {
        const image = element(doc, 'img', 'gallery-selected-image');
        image.alt = `${row.title} visual evidence`;
        image.src = state.media.source.url;
        image.addEventListener('load', () => dispatch({
          type: 'MEDIA_ELEMENT_LOADED', itemId: selectedItemId, memberId: selectedMemberId,
        }));
        image.addEventListener('error', () => reportMediaFailure('The selected image could not be loaded.'));
        viewerRegion.append(image);
      }
    } else viewerRegion.append(element(doc, 'div', 'gallery-loader', 'Preparing selected evidence…'));
    if (state.media.status === 'resolved') viewerRegion.append(element(doc, 'div', 'gallery-loader', 'Loading media bytes…'));
    if (state.media.posterError) viewerRegion.append(element(doc, 'p', 'gallery-media-warning', state.media.posterError));
    const member = selectSelectedMember(state);
    if (member) viewerRegion.append(element(doc, 'p', 'gallery-member-label', `${member.role} · ${member.name}`));
  }

  function renderFilmstrip() {
    filmstripRegion.replaceChildren();
    if (state.mode !== 'workbench') return;
    filmstripRegion.setAttribute('aria-label', 'Nearby visual evidence');
    for (const row of selectLocalFilmstrip(state)) {
      const choice = button(doc, '', 'filmstrip-select', () => void selectItem(row.id));
      choice.setAttribute('aria-label', row.testLabel);
      const thumbnail = state.thumbnails[row.id];
      if (row.kind === 'image' && thumbnail) {
        const image = element(doc, 'img', 'gallery-filmstrip-image');
        image.alt = '';
        image.src = thumbnail;
        choice.append(image);
      } else {
        choice.append(element(doc, 'span', null, row.kind === 'video' ? 'Video' : 'Photo'));
        if (row.kind === 'image' && thumbnailResolutionEnabled) resolveThumbnail(row);
      }
      filmstripRegion.append(choice);
    }
  }

  function appendContextPair(list, label, value) {
    const term = element(doc, 'dt', null, label);
    const description = element(doc, 'dd');
    description.append(bdi(doc, value ?? 'Not recorded'));
    list.append(term, description);
  }

  function renderContext() {
    contextRegion.replaceChildren();
    contextRegion.hidden = state.mode !== 'workbench' || !state.layers.context;
    if (contextRegion.hidden) return;
    const heading = element(doc, 'h2', null, 'Test context');
    heading.tabIndex = -1;
    heading.dataset.focusKey = 'context-heading';
    contextRegion.append(heading);
    if (viewportMode() !== 'desktop') contextRegion.append(button(doc, 'Close test context', 'close-context', () => {
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      restoreFocus(focusKey);
    }));
    const detail = state.detail;
    const row = selectSelectedRow(state);
    if (!detail || !row) {
      contextRegion.append(element(doc, 'div', 'gallery-loader', 'Loading test context…'));
      return;
    }
    const list = element(doc, 'dl', 'gallery-context-list');
    appendContextPair(list, 'Audit', detail.item.auditAssociations.map(({ id, title }) => `${id}: ${title}`).join('; '));
    appendContextPair(list, 'Expected', detail.item.auditAssociations.map(({ expected }) => expected).join('; '));
    appendContextPair(list, 'Observed', detail.item.capture.observedState);
    appendContextPair(list, 'Reviewed outcome', detail.item.attempt.status);
    appendContextPair(list, 'Raw browser result', detail.item.attempt.rawStatus);
    appendContextPair(list, 'Status authority', detail.item.attempt.statusSource === 'reviewed-manifest'
      ? 'Structured audit review'
      : detail.item.attempt.statusSource === 'release-integrity'
        ? 'Release integrity review'
        : 'Live browser result (provisional)');
    appendContextPair(list, 'Review reason codes', detail.item.attempt.reviewReasonCodes.join(', ') || null);
    appendContextPair(list, 'Environment', detail.item.project.environment);
    appendContextPair(list, 'Route', detail.item.capture.route);
    appendContextPair(list, 'Browser / project', `${detail.item.project.browser} / ${detail.item.project.name}`);
    appendContextPair(list, 'Device', detail.item.project.deviceClass);
    appendContextPair(list, 'Viewport', detail.item.capture.viewport ? `${detail.item.capture.viewport.width} × ${detail.item.capture.viewport.height}` : null);
    appendContextPair(list, 'Attempt', `${detail.item.attempt.ordinal}; retry ${detail.item.attempt.retry}`);
    appendContextPair(list, 'Capture rationale', detail.item.capture.rationale);
    appendContextPair(list, 'Captured', detail.item.capture.capturedAt);
    contextRegion.append(list);
    const review = element(doc, 'section', 'gallery-review-state');
    review.append(element(doc, 'h3', null, 'Reviewer flags'));
    if (detail.review.flags.length === 0) review.append(element(doc, 'p', null, 'No reviewer flag is attached to this evidence.'));
    else for (const flag of detail.review.flags.slice(0, 20)) {
      const flagCopy = element(doc, 'p');
      flagCopy.append(bdi(doc, `${flag.state ?? 'flagged'} · ${flag.reviewer ?? 'Reviewer'} · ${flag.note ?? flag.justification ?? ''}`));
      review.append(flagCopy);
    }
    if (state.capability.flagsMutable) review.append(button(doc, 'Flag visual issue', 'open-flag', () => options.onFlagIntent?.(state.selection.itemId)));
    else review.append(element(doc, 'p', 'gallery-read-only', 'Reviewer flags are read-only here.'));
    contextRegion.append(review);
  }

  function renderOverview() {
    overviewRegion.replaceChildren();
    overviewRegion.hidden = state.mode !== 'overview';
    if (overviewRegion.hidden) return;
    const heading = element(doc, 'h2', null, 'Visual overview');
    overviewRegion.append(heading);
    const grid = element(doc, 'div', 'gallery-overview-grid');
    const selectedIndex = Math.max(0, state.accepted.items.findIndex(({ id }) => id === state.selection.itemId));
    const overviewStart = Math.max(0, Math.min(
      selectedIndex - Math.floor(GALLERY_LIMITS.overviewItems / 2),
      state.accepted.items.length - GALLERY_LIMITS.overviewItems,
    ));
    const items = state.accepted.items.slice(overviewStart, overviewStart + GALLERY_LIMITS.overviewItems);
    activeOverviewObserver?.disconnect?.();
    activeOverviewObserver = null;
    const observer = typeof options.observerFactory === 'function'
      ? options.observerFactory((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const row = items.find(({ id }) => id === entry.target.dataset.itemId);
            if (row?.kind === 'image') resolveThumbnail(row);
            observer?.unobserve?.(entry.target);
          }
        })
      : null;
    activeOverviewObserver = observer;
    for (const row of items) {
      const card = button(doc, '', 'overview-select', () => {
        abort('detail');
        abort('availability');
        abort('media');
        dispatch({
          type: 'SELECT_ITEM', itemId: row.id, forceHistory: true,
          historyItemId: row.id, historyFocusKey: `overview-${row.id}`,
        });
        dispatch({ type: 'SET_MODE', mode: 'workbench' });
        void loadSelected();
      });
      card.dataset.itemId = row.id;
      card.dataset.focusKey = `overview-${row.id}`;
      const thumbnail = state.thumbnails[row.id];
      if (row.kind === 'image') {
        const image = element(doc, 'img', 'gallery-overview-image');
        image.alt = '';
        image.dataset.itemId = row.id;
        if (thumbnail) image.src = thumbnail;
        else if (thumbnailResolutionEnabled) observer?.observe?.(image);
        card.append(image);
      } else card.append(element(doc, 'span', 'gallery-video-placeholder', 'Video · metadata loads only when selected'));
      const label = element(doc, 'span', 'gallery-overview-label');
      label.append(bdi(doc, row.testLabel));
      card.append(label);
      grid.append(card);
    }
    overviewRegion.append(grid);
    if (state.accepted.nextCursor) overviewRegion.append(button(doc, 'Load more evidence', 'overview-load-more', () => {
      void loadSequence({ append: true, restoreAnchor: false });
    }));
  }

  function renderHelp() {
    const existing = shell.querySelector?.('[data-gallery-help]');
    existing?.remove?.();
    if (!state.layers.help) return;
    const dialog = element(doc, 'dialog', 'gallery-help');
    dialog.dataset.galleryHelp = 'true';
    dialog.dataset.galleryShortcuts = 'owned';
    dialog.setAttribute('aria-labelledby', 'gallery-help-title');
    const heading = element(doc, 'h2', null, 'Gallery keyboard shortcuts');
    heading.id = 'gallery-help-title';
    heading.tabIndex = -1;
    const list = element(doc, 'ul');
    for (const copy of [
      'Left / Right: previous or next evidence item',
      'Up / Down: previous or next test group',
      '[ / ]: previous or next comparison member',
      'Space: play or pause the selected video when the viewer owns focus',
      'I: toggle test context',
      'F: enter or leave fullscreen',
      'Escape: close one gallery layer',
      '?: open this shortcut help',
    ]) list.append(element(doc, 'li', null, copy));
    dialog.append(heading, list, button(doc, 'Close shortcuts', 'close-help', () => {
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'help' });
      restoreFocus(focusKey);
    }));
    const closeDialog = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      event.preventDefault?.();
      event.stopPropagation?.();
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'help' });
      restoreFocus(focusKey);
    };
    dialog.addEventListener('keydown', closeDialog);
    dialog.addEventListener('cancel', closeDialog);
    shell.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.open = true;
    scheduler(() => heading.focus?.());
  }

  function render(targets = new Set(['status', 'controls', 'queue', 'viewer', 'filmstrip', 'context', 'overview', 'help'])) {
    shell.dataset.responsivePanel = state.layers.responsivePanel ?? 'none';
    if (targets.has('status')) renderStatus();
    if (targets.has('controls')) renderControls();
    if (targets.has('queue')) renderQueue();
    if (targets.has('viewer')) renderViewer();
    if (targets.has('filmstrip')) renderFilmstrip();
    if (targets.has('context')) renderContext();
    if (targets.has('overview')) renderOverview();
    if (targets.has('help')) renderHelp();
    if (!firstUsableEmitted && state.accepted.items.length > 0 && state.detail
      && ['resolved', 'ready', 'error'].includes(state.media.status)) {
      firstUsableEmitted = true;
      options.onFirstUsable?.({ itemId: state.selection.itemId, state });
      scheduler(() => {
        if (destroyed) return;
        thumbnailResolutionEnabled = true;
        render(new Set(['filmstrip', 'overview']));
      });
    }
  }

  render();

  return Object.freeze({
    initialize,
    loadHead,
    loadSequence,
    loadSelected,
    resolveSelectedMedia,
    probeSelectedAvailability,
    applyPendingRevision,
    setQuery,
    selectItem,
    selectMember,
    mutateFlag,
    dispatch,
    getState: () => state,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    destroy() {
      destroyed = true;
      for (const slot of REQUEST_SLOTS) abort(slot);
      activeOverviewObserver?.disconnect?.();
      clearVideo(activeVideo);
      shell.removeEventListener('keydown', onKeydown);
      doc.defaultView?.removeEventListener?.('resize', onViewportResize);
      root.replaceChildren();
      subscribers.clear();
    },
  });
}
