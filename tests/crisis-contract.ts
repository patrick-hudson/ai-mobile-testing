export const CRISIS_ACTIONS = [
  { name: 'Open Discord #sos', href: 'https://discord.gg/quitting7oh', urgent: true },
  { name: 'Can’t sleep', href: '/start-here/7-oh-withdrawal-guide#sleep', urgent: false },
  { name: 'Stomach / RLS', href: '/medications-supplements/helper-meds#anti-nausea', urgent: false },
  { name: 'Anxiety', href: '/medications-supplements/helper-meds#clonidine', urgent: false },
  { name: /Paths off 7-OH/, href: '/start-here/how-to-quit-7-oh', urgent: false },
  { name: 'Call or text 988', href: 'tel:988', urgent: false },
  { name: /Open the full guide/, href: '/start-here/7-oh-withdrawal-guide', urgent: false },
  { name: /Set up medications and supplies/, href: '/start-here/7-oh-withdrawal-quickstart', urgent: false },
] as const;

export const CRISIS_MEETING_FALLBACK = '/next-kratom-support-meeting';
