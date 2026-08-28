export type CandidateRouteKind =
  | 'home'
  | 'category'
  | 'article'
  | 'calculator'
  | 'crisis'
  | 'meeting'
  | 'search'
  | 'utility';

export interface CandidateRoute {
  path: string;
  kind: CandidateRouteKind;
  expectedH1: string;
  expectedTitle: string;
  productionH1Aliases?: readonly string[];
  productionTitleAliases?: readonly string[];
}

export interface DeclaredVisualItem {
  name: string;
  selector: string;
  kind: 'img' | 'picture' | 'svg' | 'css-diagram';
  exactCount: number;
}

export interface RouteVisualContract {
  path: string;
  items: readonly DeclaredVisualItem[];
}

export interface CriticalContentContract {
  path: string;
  requiredHeadings: readonly string[];
  requiredWarningFragments: readonly string[];
  requiredCandidateDestinations: readonly string[];
  /** Exact production headings reviewed as intentionally absent on candidate. */
  approvedMissingProductionHeadings: readonly string[];
}

export interface CategoryIndexItemContract {
  path: string;
  title: string;
  lastUpdated: string;
}

export interface CategoryIndexContract {
  path: string;
  expectedGroupCount: number;
  items: readonly CategoryIndexItemContract[];
}

export interface ReviewedNavigationDestination {
  path: string;
  label: string;
}

export interface ReviewedHomeAction extends ReviewedNavigationDestination {
  expectedH1: string;
}

export interface HomeSupportActionContract {
  accessibleName: string;
  href: string;
  target: string | null;
  rel: string | null;
}

export interface HomeSupportStateContract {
  id: 'fallback' | 'upcoming' | 'live';
  at: string;
  requiredTextLines: readonly string[];
  actions: readonly HomeSupportActionContract[];
}

export interface ReviewedHomeLiveMeetingIndex {
  generatedAt: string;
  featuredNa: {
    provider: 'NA';
    id: string;
    name: string;
    joinUrl: string;
    platform: string;
    day: number;
    hour: number;
    minute: number;
    timezone: string;
    alwaysAvailable: true;
  };
  na: readonly never[];
  smart: readonly never[];
}

export type ReviewedHeaderControlId = 'guide' | 'home' | 'meeting' | 'discord' | 'search' | 'appearance' | 'help';

export interface HeaderBreakpointContract {
  width: number;
  controlIds: readonly ReviewedHeaderControlId[];
}

export interface ReviewedHeaderControl {
  id: ReviewedHeaderControlId;
  href: string | null;
  accessibleName: string;
  nameMatch: 'exact' | 'prefix';
  minimumWidth: number;
  minimumHeight: number;
}

export interface ReviewedFooterAction {
  label: string;
  href: string;
  target: string | null;
  rel: string | null;
}

export interface ReviewedSearchResultContract {
  query: string;
  href: string;
  eyebrow: string;
  title: string;
  highlight: string;
  excerptPrefix: string;
}

/**
 * Static release inventory. Keeping this list explicit makes additions and removals
 * reviewable in pull requests instead of silently accepting whatever a crawl finds.
 * README.md is intentionally not published and therefore is not included.
 */
const CONTENT_PAGES = {
  about: [
    { slug: 'acknowledgments', title: 'Acknowledgments' },
    { slug: 'changelog', title: 'Changelog' },
    { slug: 'contributing', title: 'Contributing & Feedback' },
    { slug: 'site-architecture', title: 'Site Architecture' },
    { slug: 'the-community', title: 'The Community' },
    { slug: 'this-site', title: 'About This Site' },
    { slug: 'where-we-stand', title: 'Where the Site Stands' },
  ],
  compounds: [
    { slug: '7-oh-ban', title: 'The Federal 7-OH Ban: Dates, Scope, What It Means' },
    { slug: '7-oh', title: '7-OH (7-Hydroxymitragynine)' },
    { slug: 'cats-claw', title: 'Cat’s Claw' },
    { slug: 'kratom-leaf', title: 'Kratom Leaf & Mitragynine' },
    { slug: 'mgm15', title: 'MGM-15' },
    { slug: 'mgm16', title: 'MGM-16' },
    { slug: 'mit-a-dhm', title: 'MIT-A and DHM' },
    { slug: 'mitragynine-pseudoindoxyl', title: '7-Pseudoindoxyl / MP (Mitragynine Pseudoindoxyl)' },
  ],
  'for-loved-ones': [
    { slug: 'asking-them-to-leave', title: 'Asking Them to Leave the House' },
    { slug: 'at-home-recovery', title: 'When They’re Recovering at Home' },
    { slug: 'boundaries', title: 'Boundaries Without Punishment' },
    { slug: 'fmla-workplace', title: 'FMLA & Workplace Protections (for caregivers)' },
    { slug: 'how-to-talk', title: 'How to Talk to Your Loved One' },
    { slug: 'rehabilitation-centers', title: 'Rehabilitation Centers' },
    { slug: 'safety', title: 'Safety: You and Your Kids Come First' },
    { slug: 'support-groups', title: 'Support Groups for Family & Friends' },
    { slug: 'taking-care-of-yourself', title: 'Taking Care of Yourself' },
    { slug: 'welcome', title: 'For Loved Ones — Start Here' },
    { slug: 'what-to-expect', title: 'What to Expect: Addiction, Withdrawal & the Long Road of Recovery' },
  ],
  'for-you': [
    { slug: 'at-home-treatment', title: 'At-Home Treatment' },
    { slug: 'fmla-ada-job', title: 'FMLA, ADA & Your Job' },
    { slug: 'mat-and-your-job', title: 'MAT & Your Professional License' },
    { slug: 'mutual-aid', title: 'Mutual Aid & Recovery Groups' },
    { slug: 'rehabilitation-centers', title: 'Rehabilitation Centers' },
    { slug: 'sober-living', title: 'Sober Living Homes' },
    { slug: 'tapering-7oh', title: 'Tapering Off 7-OH' },
    { slug: 'welcome', title: 'For You: Start Here' },
  ],
  'mat-suboxone': [
    { slug: 'long-term-suboxone-risks', title: 'What You Should Know About Long-Term Suboxone' },
    { slug: 'sows-cows-induction-guide', title: 'SOWS & COWS Guide' },
    { slug: 'sublocade-brixadi', title: 'Sublocade & Brixadi: Long-Acting Buprenorphine Injections' },
    { slug: 'suboxone-bernese-method', title: 'Bernese Method (Micro-Induction)' },
    { slug: 'suboxone-custom-dose', title: 'Custom Suboxone Dosing' },
    { slug: 'suboxone-for-7oh', title: 'Suboxone' },
    { slug: 'suboxone-rapid-taper', title: 'Suboxone Rapid Taper' },
    { slug: 'why-suboxone-isnt-working', title: 'Why Suboxone Might Not Be Working: Read This First' },
  ],
  'medications-supplements': [
    { slug: 'cannabis-thc-in-recovery', title: 'Cannabis and THC in Recovery' },
    { slug: 'helper-meds', title: 'Helper Medications' },
    { slug: 'mega-dose-vitamin-c', title: 'Mega-Dose Vitamin C' },
    { slug: 'nad-iv-therapy', title: 'NAD+ IV Therapy' },
    { slug: 'peptides-for-withdrawal', title: 'Peptides for 7-OH and Kratom-Synthetic Withdrawal' },
    { slug: 'quit-7-oh-with-kratom-leaf', title: 'Quit 7-OH with Kratom Leaf' },
    { slug: 'quit-7-oh-with-mitragynine', title: 'Quit 7-OH with Concentrated Mitragynine' },
    { slug: 'quit-kit', title: 'Quit Kit & QuitK' },
    { slug: 'sr-17', title: 'SR-17' },
    { slug: 'vitamins-supplements', title: 'Vitamins & Supplements' },
  ],
  pharmacology: [
    { slug: 'chemical-structures', title: 'Chemical Structures (Appendix)' },
    { slug: 'kratom-minor-alkaloids', title: 'Kratom’s Minor Alkaloids' },
    { slug: 'morphine-vs-kratom', title: 'Morphine vs. Mitragyna Alkaloids' },
  ],
  'post-acute': [
    { slug: '7-oh-recovery-timeline', title: 'Long-Term Outlook' },
    { slug: 'depression-and-anhedonia', title: 'Depression and Anhedonia' },
    { slug: 'dopamine-recovery', title: 'Dopamine Recovery' },
    { slug: 'endocrine-recovery', title: 'Endocrine Recovery After 7-OH and Kratom' },
    { slug: 'impending-doom-anxiety', title: 'Impending Doom' },
    { slug: 'kindling-and-relapse', title: 'Will One Use Bring Withdrawal Back? (Kindling)' },
    { slug: 'naltrexone-low-dose', title: 'Low-Dose Naltrexone (LDN)' },
    { slug: 'naltrexone-normal-dose', title: 'Normal-Dose Naltrexone (Oral and Vivitrol)' },
    { slug: 'naltrexone-ultra-low-dose', title: 'Ultra-Low-Dose Naltrexone (ULDN)' },
    { slug: 'naltrexone', title: 'Naltrexone (Overview)' },
    { slug: 'paws-post-acute-withdrawal', title: 'What is PAWS? A Field Guide to Post-Acute Withdrawal' },
    { slug: 'pink-cloud', title: 'The Pink Cloud' },
    { slug: 'sleep-recovery', title: 'Sleep Recovery: The Long Road Back to Real Sleep' },
  ],
  resources: [
    { slug: '7-oh-taper-calculator', title: '7-OH Taper Calculator' },
    { slug: 'crisis-hotlines', title: 'Crisis Hotlines' },
    { slug: 'kratom-leaf-taper-calculator', title: 'Kratom Leaf Taper Calculator' },
    { slug: 'meeting-schedules', title: 'Meeting Schedules' },
    { slug: 'recovery-coaching', title: 'Recovery Coaching' },
    { slug: 'sr-17-taper-calculator', title: 'SR-17 Taper Calculator' },
    { slug: 'suboxone-taper-calculator', title: 'Suboxone Taper Calculator' },
    { slug: 'taper-calculator', title: 'Taper Calculators' },
    { slug: 'telehealth-for-suboxone', title: 'Telehealth Providers for Suboxone (Comparison)' },
  ],
  'start-here': [
    { slug: '7-oh-withdrawal-guide', title: '7-OH Withdrawal Guide' },
    { slug: '7-oh-withdrawal-help', title: 'You’re in Withdrawal Right Now' },
    { slug: '7-oh-withdrawal-quickstart', title: 'Withdrawal Quickstart' },
    { slug: 'cravings-and-relapse-thoughts', title: 'Thinking About Using? (The Fuck Its)' },
    { slug: 'how-to-quit-7-oh', title: 'Paths Off 7-OH' },
    { slug: 'how-to-use-this-website', title: 'How to Use This Website' },
    { slug: 'welcome', title: 'Welcome' },
    { slug: 'what-is-7-oh', title: 'What the Hell Is 7-OH?' },
  ],
} as const satisfies Record<string, readonly { slug: string; title: string }[]>;

const CATEGORY_TITLES = {
  about: 'Site & Community',
  compounds: 'Compounds',
  'for-loved-ones': 'For Loved Ones',
  'for-you': 'For You',
  'mat-suboxone': 'MAT / Suboxone',
  'medications-supplements': 'Meds & Supplements',
  pharmacology: 'Pharmacology',
  'post-acute': 'Post-Acute',
  resources: 'Resources',
  'start-here': 'Start Here',
} as const satisfies Record<keyof typeof CONTENT_PAGES, string>;

const CALCULATOR_PATHS = new Set([
  '/resources/7-oh-taper-calculator',
  '/resources/kratom-leaf-taper-calculator',
  '/resources/sr-17-taper-calculator',
  '/resources/suboxone-taper-calculator',
  '/resources/taper-calculator',
]);

const CATEGORY_ROUTES: CandidateRoute[] = Object.keys(CONTENT_PAGES).map((category) => {
  const title = CATEGORY_TITLES[category as keyof typeof CATEGORY_TITLES];
  return {
    path: `/${category}`,
    kind: 'category',
    expectedH1: title,
    expectedTitle: title,
    ...(category === 'medications-supplements'
      ? {
          productionH1Aliases: ['Other Tools', 'Medications & Supplements', 'Adjuncts & Supplements'],
          productionTitleAliases: ['Other Tools', 'Medications & Supplements', 'Adjuncts & Supplements'],
        }
      : {}),
  };
});

const CONTENT_ROUTES: CandidateRoute[] = Object.entries(CONTENT_PAGES).flatMap(
  ([category, pages]) =>
    pages.map(({ slug, title }): CandidateRoute => {
      const path = `/${category}/${slug}`;
      const identity = {
        expectedH1: path === '/start-here/7-oh-withdrawal-help' ? 'You’re going to be okay.' : title,
        expectedTitle: title,
        ...(path === '/start-here/7-oh-withdrawal-help'
          ? {
              productionH1Aliases: ['You’re in Withdrawal Right Now'],
            }
          : {}),
        ...(path === '/resources/sr-17-taper-calculator'
          ? { productionH1Aliases: ['SR-17 Cross-Taper Calculator'], productionTitleAliases: ['SR-17 Cross-Taper Calculator'] }
          : {}),
      };
      if (path === '/start-here/7-oh-withdrawal-help') return { path, kind: 'crisis', ...identity };
      if (CALCULATOR_PATHS.has(path)) return { path, kind: 'calculator', ...identity };
      if (path === '/resources/meeting-schedules') return { path, kind: 'meeting', ...identity };
      return { path, kind: 'article', ...identity };
    }),
);

const CUSTOM_HTML_ROUTES: CandidateRoute[] = [
  {
    path: '/',
    kind: 'home',
    expectedH1: 'Help quitting 7-OH',
    expectedTitle: '7-OH Withdrawal Help & Taper Guides',
    productionH1Aliases: ['A calm reference for getting off 7-OH and kratom synthetics.'],
    productionTitleAliases: ['quitting7oh.org — recovery information'],
  },
  {
    path: '/brand',
    kind: 'utility',
    expectedH1: 'The quitting7oh.org visual system',
    expectedTitle: 'Brand & Style Guide',
    productionH1Aliases: ['The look & feel of quitting7oh'],
  },
  {
    path: '/next-kratom-support-meeting',
    kind: 'meeting',
    expectedH1: 'Next 7-OH and kratom support meeting',
    expectedTitle: 'Next 7-OH and kratom support meeting',
    productionH1Aliases: ['Next kratom support meeting'],
    productionTitleAliases: ['Next kratom support meeting'],
  },
  { path: '/search', kind: 'search', expectedH1: 'Search the guide', expectedTitle: 'Search the guide' },
  { path: '/sitemap', kind: 'utility', expectedH1: 'Site map', expectedTitle: 'Site map' },
  { path: '/virtual-na-meetings-now', kind: 'meeting', expectedH1: 'Find a virtual NA meeting happening now', expectedTitle: 'Find a virtual NA meeting happening now' },
  { path: '/virtual-smart-meetings-now', kind: 'meeting', expectedH1: 'Find a virtual SMART Recovery meeting happening now', expectedTitle: 'Find a virtual SMART Recovery meeting happening now' },
];

export const CANDIDATE_HTML_ROUTES: readonly CandidateRoute[] = [
  ...CUSTOM_HTML_ROUTES,
  ...CATEGORY_ROUTES,
  ...CONTENT_ROUTES,
];

export const CANDIDATE_PATHS: readonly string[] = CANDIDATE_HTML_ROUTES.map(({ path }) => path);

/**
 * Reviewed metadata for the representative category-index acceptance audit.
 * Exact paths, titles, order, and update dates make a content-card substitution
 * visible instead of accepting any eight healthy links as an equivalent index.
 */
export const START_HERE_CATEGORY_INDEX_CONTRACT: CategoryIndexContract = {
  path: '/start-here',
  expectedGroupCount: 1,
  items: [
    { path: '/start-here/welcome', title: 'Welcome', lastUpdated: '2026-08-22' },
    { path: '/start-here/what-is-7-oh', title: 'What the Hell Is 7-OH?', lastUpdated: '2026-05-25' },
    { path: '/start-here/how-to-use-this-website', title: 'How to Use This Website', lastUpdated: '2026-08-22' },
    { path: '/start-here/7-oh-withdrawal-help', title: "You're in Withdrawal Right Now", lastUpdated: '2026-08-22' },
    { path: '/start-here/7-oh-withdrawal-quickstart', title: 'Withdrawal Quickstart', lastUpdated: '2026-08-22' },
    { path: '/start-here/7-oh-withdrawal-guide', title: '7-OH Withdrawal Guide', lastUpdated: '2026-08-22' },
    { path: '/start-here/how-to-quit-7-oh', title: 'Paths Off 7-OH', lastUpdated: '2026-08-22' },
    { path: '/start-here/cravings-and-relapse-thoughts', title: 'Thinking About Using? (The Fuck Its)', lastUpdated: '2026-06-09' },
  ],
} as const;

export const REVIEWED_GUIDE_CATEGORIES: readonly ReviewedNavigationDestination[] = [
  { path: '/start-here', label: 'Start Here' },
  { path: '/for-you', label: 'For You' },
  { path: '/for-loved-ones', label: 'For Loved Ones' },
  { path: '/mat-suboxone', label: 'MAT / Suboxone' },
  { path: '/medications-supplements', label: 'Meds & Supplements' },
  { path: '/post-acute', label: 'Post-Acute' },
  { path: '/compounds', label: 'Compounds' },
  { path: '/pharmacology', label: 'Pharmacology' },
  { path: '/resources', label: 'Resources' },
  { path: '/about', label: 'Site & Community' },
] as const;

export const REVIEWED_HOME_PRIMARY_ACTIONS = {
  candidate: [
    { path: '/start-here/7-oh-withdrawal-quickstart', label: 'Withdrawal quickstart', expectedH1: 'Withdrawal Quickstart' },
    { path: '/start-here/how-to-quit-7-oh', label: 'Compare quitting options', expectedH1: 'Paths Off 7-OH' },
  ],
  production: [
    { path: '/start-here/7-oh-withdrawal-help', label: 'In active withdrawal right now? What to do this hour →', expectedH1: "You're in Withdrawal Right Now" },
    { path: '/start-here/how-to-quit-7-oh', label: 'Ready to quit? The six paths, ranked by what fits →', expectedH1: 'Paths Off 7-OH' },
  ],
} as const satisfies Record<'candidate' | 'production', readonly ReviewedHomeAction[]>;

/**
 * Deterministic homepage support-panel states. The frozen instants exercise a
 * reviewed Wednesday TIAWO occurrence plus the independently reviewed 24/7 NA
 * fallback. Exact labels and destinations prevent arbitrary support links from
 * satisfying the P0 current-support promise.
 */
export const REVIEWED_HOME_LIVE_MEETING_INDEX: ReviewedHomeLiveMeetingIndex = {
  generatedAt: '2026-08-24T00:00:00.000Z',
  featuredNa: {
    provider: 'NA',
    id: 'OLM223-323542-230770',
    name: 'NA 24/7 Online Meeting',
    joinUrl: 'https://us02web.zoom.us/j/558544927?pwd=247247',
    platform: 'Zoom',
    day: 0,
    hour: 1,
    minute: 0,
    timezone: 'US/Eastern',
    alwaysAvailable: true,
  },
  na: [],
  smart: [],
} as const;

export const REVIEWED_HOME_SUPPORT_STATES: readonly HomeSupportStateContract[] = [
  {
    id: 'fallback',
    at: '2026-08-24T13:50:00Z',
    requiredTextLines: [
      'Next 7-OH/kratom meeting · in 10 min',
      'Kratom Anonymous · Today 9:00 AM · Discussion',
      'Join a meeting now',
      'Narcotics Anonymous · NA 24/7 Online Meeting · always open',
      'NA runs virtually 24/7',
    ],
    actions: [
      { accessibleName: 'Discord', href: 'https://discord.gg/quitting7oh', target: '_blank', rel: 'noopener noreferrer' },
      { accessibleName: 'In active withdrawal? What to do this hour, step by step', href: '/start-here/7-oh-withdrawal-help', target: null, rel: null },
      { accessibleName: 'Next 7-OH/kratom meeting · in 10 min Kratom Anonymous · Today 9:00 AM · Discussion', href: 'https://us06web.zoom.us/j/85416304667?pwd=pkbSAebEMTzfj65ldpcbekavV2Yi0k.1', target: '_blank', rel: 'noopener noreferrer' },
      { accessibleName: 'All 7-OH and kratom meetings', href: '/next-kratom-support-meeting', target: null, rel: null },
      { accessibleName: 'Join', href: 'https://us02web.zoom.us/j/558544927?pwd=247247', target: '_blank', rel: 'noopener noreferrer' },
      { accessibleName: 'Browse NA', href: '/virtual-na-meetings-now', target: null, rel: null },
      { accessibleName: 'Browse SMART', href: '/virtual-smart-meetings-now', target: null, rel: null },
    ],
  },
  {
    id: 'upcoming',
    at: '2026-08-26T11:50:00Z',
    requiredTextLines: [
      'Next 7-OH/kratom meeting · in 10 min',
      'TIAWO · Today 7:00 AM · Morning',
      'Join a meeting now',
      'Narcotics Anonymous · NA 24/7 Online Meeting · always open',
      'NA runs virtually 24/7',
    ],
    actions: [
      { accessibleName: 'Discord', href: 'https://discord.gg/quitting7oh', target: '_blank', rel: 'noopener noreferrer' },
      { accessibleName: 'In active withdrawal? What to do this hour, step by step', href: '/start-here/7-oh-withdrawal-help', target: null, rel: null },
      { accessibleName: 'Next 7-OH/kratom meeting · in 10 min TIAWO · Today 7:00 AM · Morning', href: 'https://meet.google.com/cza-tyjv-fun', target: '_blank', rel: 'noopener noreferrer' },
      { accessibleName: 'All 7-OH and kratom meetings', href: '/next-kratom-support-meeting', target: null, rel: null },
      { accessibleName: 'Join', href: 'https://us02web.zoom.us/j/558544927?pwd=247247', target: '_blank', rel: 'noopener noreferrer' },
      { accessibleName: 'Browse NA', href: '/virtual-na-meetings-now', target: null, rel: null },
      { accessibleName: 'Browse SMART', href: '/virtual-smart-meetings-now', target: null, rel: null },
    ],
  },
  {
    id: 'live',
    at: '2026-08-26T12:10:00Z',
    requiredTextLines: [
      'LIVE NOW · 7-OH / KRATOM',
      'TIAWO — Morning',
      '50 min remaining · Google Meet',
      'Join a meeting now',
      'Narcotics Anonymous · NA 24/7 Online Meeting · always open',
      'NA runs virtually 24/7',
    ],
    actions: [
      { accessibleName: 'Discord', href: 'https://discord.gg/quitting7oh', target: '_blank', rel: 'noopener noreferrer' },
      { accessibleName: 'In active withdrawal? What to do this hour, step by step', href: '/start-here/7-oh-withdrawal-help', target: null, rel: null },
      { accessibleName: 'Join live', href: 'https://meet.google.com/cza-tyjv-fun', target: '_blank', rel: 'noopener noreferrer' },
      { accessibleName: 'Full schedule', href: '/next-kratom-support-meeting', target: null, rel: null },
      { accessibleName: 'Join', href: 'https://us02web.zoom.us/j/558544927?pwd=247247', target: '_blank', rel: 'noopener noreferrer' },
      { accessibleName: 'Browse NA', href: '/virtual-na-meetings-now', target: null, rel: null },
      { accessibleName: 'Browse SMART', href: '/virtual-smart-meetings-now', target: null, rel: null },
    ],
  },
] as const;

export const REVIEWED_HEADER_BREAKPOINTS: readonly HeaderBreakpointContract[] = [
  { width: 320, controlIds: ['guide', 'home', 'search', 'help'] },
  { width: 360, controlIds: ['guide', 'home', 'search', 'help'] },
  { width: 520, controlIds: ['guide', 'home', 'meeting', 'search', 'help'] },
  { width: 719, controlIds: ['guide', 'home', 'meeting', 'search', 'help'] },
  { width: 720, controlIds: ['guide', 'home', 'meeting', 'search', 'appearance', 'help'] },
  { width: 760, controlIds: ['guide', 'home', 'meeting', 'discord', 'search', 'appearance', 'help'] },
  { width: 900, controlIds: ['guide', 'home', 'meeting', 'discord', 'search', 'appearance', 'help'] },
  { width: 1024, controlIds: ['home', 'meeting', 'discord', 'search', 'appearance', 'help'] },
  { width: 1440, controlIds: ['home', 'meeting', 'discord', 'search', 'appearance', 'help'] },
] as const;

export const REVIEWED_HEADER_CONTROLS: readonly ReviewedHeaderControl[] = [
  { id: 'guide', href: null, accessibleName: 'Open guide navigation', nameMatch: 'exact', minimumWidth: 44, minimumHeight: 44 },
  { id: 'home', href: '/', accessibleName: 'quitting7oh.org', nameMatch: 'exact', minimumWidth: 24, minimumHeight: 24 },
  { id: 'meeting', href: '/next-kratom-support-meeting', accessibleName: 'Find a meeting Meetings', nameMatch: 'exact', minimumWidth: 44, minimumHeight: 44 },
  { id: 'discord', href: 'https://discord.gg/quitting7oh', accessibleName: 'Join the quitting7oh Discord', nameMatch: 'prefix', minimumWidth: 44, minimumHeight: 44 },
  { id: 'search', href: '/search', accessibleName: 'Search the guide', nameMatch: 'exact', minimumWidth: 44, minimumHeight: 44 },
  { id: 'appearance', href: null, accessibleName: 'Appearance:', nameMatch: 'prefix', minimumWidth: 44, minimumHeight: 44 },
  { id: 'help', href: '/start-here/7-oh-withdrawal-help', accessibleName: 'Help now', nameMatch: 'exact', minimumWidth: 44, minimumHeight: 44 },
] as const;

export const REVIEWED_FOOTER_ACTIONS: readonly ReviewedFooterAction[] = [
  { label: 'Crisis and urgent help', href: '/resources/crisis-hotlines', target: null, rel: null },
  { label: 'Withdrawal help', href: '/start-here/7-oh-withdrawal-guide', target: null, rel: null },
  { label: 'Next support meeting', href: '/next-kratom-support-meeting', target: null, rel: null },
  { label: 'Site map', href: '/sitemap', target: null, rel: null },
  { label: 'Changelog', href: '/about/changelog', target: null, rel: null },
  { label: 'Discord ↗', href: 'https://discord.gg/quitting7oh', target: '_blank', rel: 'noopener noreferrer' },
  { label: 'GitHub ↗', href: 'https://github.com/quitting7oh/quitting7oh.org', target: '_blank', rel: 'noopener noreferrer' },
] as const;

export const REVIEWED_CLONIDINE_SEARCH_RESULT: ReviewedSearchResultContract = {
  query: 'clonidine',
  href: '/medications-supplements/helper-meds#clonidine',
  eyebrow: 'Meds & Supplements · Guide',
  title: 'Helper Medications',
  highlight: 'Clonidine',
  excerptPrefix: 'Alpha-2 adrenergic agonist that blocks the noradrenergic surge driving most physical withdrawal symptoms.',
} as const;

/**
 * Public HTML routes deliberately omitted from the human-facing site map.
 * Every other reviewed route must be linked from `/sitemap`; keeping this
 * exception ledger explicit prevents a partial directory from passing on a
 * loose minimum-count assertion.
 */
export const HUMAN_SITEMAP_EXCLUDED_PATHS = [
  '/',
  '/brand',
  '/search',
  '/sitemap',
] as const;

export const DATA_ENDPOINTS = [
  { path: '/search-index.json', name: 'search index' },
  { path: '/live-meeting-index.json', name: 'live meeting index' },
] as const;

export const REPRESENTATIVE_VISUAL_ROUTES = [
  { path: '/', label: 'homepage' },
  { path: '/start-here/welcome', label: 'article' },
  { path: '/start-here', label: 'category' },
  { path: '/resources/7-oh-taper-calculator', label: 'calculator' },
  { path: '/virtual-na-meetings-now', label: 'meeting-directory' },
  { path: '/start-here/7-oh-withdrawal-help', label: 'crisis-fast-path' },
  { path: '/search', label: 'search' },
  { path: '/sitemap', label: 'sitemap' },
] as const;

/**
 * Visuals whose presence is part of the published content contract. Exact
 * counts prevent an empty page (or a silently dropped diagram) from passing.
 */
export const DECLARED_ROUTE_VISUALS: readonly RouteVisualContract[] = [
  {
    path: '/brand',
    items: [
      { name: 'light and dark Lift Cup specimens', selector: '#logo svg.logo-mark', kind: 'svg', exactCount: 2 },
    ],
  },
  {
    path: '/pharmacology/chemical-structures',
    items: [
      { name: 'reviewed molecular structure figures', selector: 'main figure img[src^="/images/structures/"]', kind: 'img', exactCount: 12 },
    ],
  },
  {
    path: '/about/site-architecture',
    items: [
      { name: 'core-stack architecture table', selector: 'main .architecture-table', kind: 'css-diagram', exactCount: 1 },
      { name: 'static publishing pipeline', selector: 'main article > .not-prose > ol', kind: 'css-diagram', exactCount: 1 },
    ],
  },
] as const;

/**
 * Release-critical content is reviewed explicitly. The approved-difference
 * arrays intentionally start empty: a removed production heading blocks the
 * release until a reviewer records the exact heading here.
 */
export const CRITICAL_CONTENT_CONTRACTS: readonly CriticalContentContract[] = [
  {
    path: '/',
    requiredHeadings: ['Help quitting 7-OH', 'Support right now'],
    requiredWarningFragments: ['community-compiled information, not medical advice'],
    requiredCandidateDestinations: ['/start-here/7-oh-withdrawal-quickstart', '/start-here/how-to-quit-7-oh'],
    approvedMissingProductionHeadings: [],
  },
  {
    path: '/start-here/welcome',
    requiredHeadings: ['Welcome', 'Scope and disclaimers', 'Where to go next', 'Find the community'],
    requiredWarningFragments: ['Not medical advice'],
    requiredCandidateDestinations: ['/start-here/7-oh-withdrawal-help', '/about/the-community'],
    approvedMissingProductionHeadings: [],
  },
  {
    path: '/compounds/7-oh',
    requiredHeadings: ['7-OH (7-Hydroxymitragynine)', 'Withdrawal profile', "If you're trying to stop"],
    requiredWarningFragments: ['No direct human PK study of standalone 7-OH has been published'],
    requiredCandidateDestinations: ['/start-here/how-to-quit-7-oh', '/start-here/7-oh-withdrawal-help'],
    approvedMissingProductionHeadings: [],
  },
  {
    path: '/resources/7-oh-taper-calculator',
    requiredHeadings: ['7-OH Taper Calculator', 'Which compound to pick', 'How the math works'],
    requiredWarningFragments: ['Reference, not advice'],
    requiredCandidateDestinations: ['/resources/taper-calculator', '/medications-supplements/helper-meds'],
    approvedMissingProductionHeadings: [],
  },
  {
    path: '/virtual-na-meetings-now',
    requiredHeadings: ['Find a virtual NA meeting happening now'],
    requiredWarningFragments: ['not affiliated with Narcotics Anonymous'],
    requiredCandidateDestinations: ['/next-kratom-support-meeting', '/for-you/mutual-aid'],
    approvedMissingProductionHeadings: [],
  },
] as const;

export const REPRESENTATIVE_A11Y_ROUTES = [
  '/',
  '/start-here/welcome',
  '/start-here/7-oh-withdrawal-help',
  '/resources/7-oh-taper-calculator',
  '/mat-suboxone/sows-cows-induction-guide',
  '/virtual-na-meetings-now',
  '/search',
] as const;

export const REPRESENTATIVE_PERFORMANCE_ROUTES = [
  '/',
  '/start-here/welcome',
  '/resources/7-oh-taper-calculator',
  '/virtual-na-meetings-now',
  '/about/changelog',
] as const;

/** Reviewed shell/content/action matrix for browser-console and first-party request health. */
export const REPRESENTATIVE_RUNTIME_ROUTES = [
  '/',
  '/start-here/welcome',
  '/compounds/7-oh',
  '/resources/7-oh-taper-calculator',
  '/virtual-na-meetings-now',
] as const;

export const EXPECTED_PUBLISHED_DOCUMENT_COUNT = 85;
export const EXPECTED_CATEGORY_COUNT = 10;
export const EXPECTED_HTML_ROUTE_COUNT = 102;
