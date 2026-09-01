import type { MessageKey } from './i18n'

export type ChangelogRelease = {
  version: string
  date: string
  noteKeys: MessageKey[]
}

export const CHANGELOG_RELEASES: ChangelogRelease[] = [
  {
    version: '2.14.0',
    date: '2026-09-01',
    noteKeys: [
      'whatsNew.v2140.note1',
      'whatsNew.v2140.note2',
      'whatsNew.v2140.note3',
      'whatsNew.v2140.note4',
    ],
  },
  {
    version: '2.13.7',
    date: '2026-08-31',
    noteKeys: ['whatsNew.v2137.note1'],
  },
  {
    version: '2.13.6',
    date: '2026-08-31',
    noteKeys: ['whatsNew.v2136.note1'],
  },
  {
    version: '2.13.5',
    date: '2026-08-31',
    noteKeys: ['whatsNew.v2135.note1'],
  },
  {
    version: '2.13.4',
    date: '2026-08-31',
    noteKeys: ['whatsNew.v2134.note1', 'whatsNew.v2134.note2'],
  },
  {
    version: '2.13.3',
    date: '2026-08-31',
    noteKeys: ['whatsNew.v2133.note1', 'whatsNew.v2133.note2', 'whatsNew.v2133.note3'],
  },
  {
    version: '2.13.2',
    date: '2026-08-31',
    noteKeys: ['whatsNew.v2132.note1', 'whatsNew.v2132.note2', 'whatsNew.v2132.note3'],
  },
  {
    version: '2.13.1',
    date: '2026-08-26',
    noteKeys: ['whatsNew.v2131.note1'],
  },
  {
    version: '2.13.0',
    date: '2026-08-26',
    noteKeys: ['whatsNew.v2130.note1', 'whatsNew.v2130.note2'],
  },
  {
    version: '2.12.1',
    date: '2026-08-26',
    noteKeys: ['whatsNew.v2121.note1', 'whatsNew.v2121.note2'],
  },
  {
    version: '2.12.0',
    date: '2026-08-25',
    noteKeys: ['whatsNew.v2120.note1'],
  },
  {
    version: '2.11.0',
    date: '2026-08-25',
    noteKeys: ['whatsNew.v2110.note1', 'whatsNew.v2110.note2'],
  },
  {
    version: '2.10.1',
    date: '2026-08-24',
    noteKeys: ['whatsNew.v2101.note1'],
  },
  {
    version: '2.10.0',
    date: '2026-08-24',
    noteKeys: ['whatsNew.v2100.note1', 'whatsNew.v2100.note2'],
  },
  {
    version: '2.9.0',
    date: '2026-08-24',
    noteKeys: ['whatsNew.v290.note1'],
  },
  {
    version: '2.8.2',
    date: '2026-08-21',
    noteKeys: ['whatsNew.v282.note1'],
  },
  {
    version: '2.8.1',
    date: '2026-08-21',
    noteKeys: ['whatsNew.v281.note1'],
  },
  {
    version: '2.8.0',
    date: '2026-08-21',
    noteKeys: ['whatsNew.v280.note1', 'whatsNew.v280.note2', 'whatsNew.v280.note3'],
  },
  {
    version: '2.7.0',
    date: '2026-08-20',
    noteKeys: ['whatsNew.v270.note1', 'whatsNew.v270.note2', 'whatsNew.v270.note3'],
  },
  {
    version: '2.6.6',
    date: '2026-08-20',
    noteKeys: ['whatsNew.v266.note1', 'whatsNew.v266.note2'],
  },
  {
    version: '2.6.5',
    date: '2026-08-20',
    noteKeys: ['whatsNew.v265.note1'],
  },
  {
    version: '2.6.4',
    date: '2026-08-20',
    noteKeys: ['whatsNew.v264.note1'],
  },
  {
    version: '2.6.3',
    date: '2026-08-20',
    noteKeys: ['whatsNew.v263.note1'],
  },
  {
    version: '2.6.2',
    date: '2026-08-20',
    noteKeys: ['whatsNew.v262.note1', 'whatsNew.v262.note2', 'whatsNew.v262.note3'],
  },
  {
    version: '2.6.1',
    date: '2026-08-19',
    noteKeys: ['whatsNew.v261.note1', 'whatsNew.v261.note2'],
  },
  {
    version: '2.6.0',
    date: '2026-08-19',
    noteKeys: ['whatsNew.v260.note1', 'whatsNew.v260.note2', 'whatsNew.v260.note3'],
  },
  {
    version: '2.5.0',
    date: '2026-08-19',
    noteKeys: ['whatsNew.v250.note1', 'whatsNew.v250.note2', 'whatsNew.v250.note3'],
  },
  {
    version: '2.4.2',
    date: '2026-08-19',
    noteKeys: ['whatsNew.v242.note1', 'whatsNew.v242.note2'],
  },
  {
    version: '2.4.1',
    date: '2026-08-19',
    noteKeys: ['whatsNew.v241.note1'],
  },
  {
    version: '2.4.0',
    date: '2026-08-19',
    noteKeys: ['whatsNew.v240.note1', 'whatsNew.v240.note2'],
  },
  {
    version: '2.3.0',
    date: '2026-08-19',
    noteKeys: ['whatsNew.v230.note1', 'whatsNew.v230.note2', 'whatsNew.v230.note3'],
  },
  {
    version: '2.2.1',
    date: '2026-08-19',
    noteKeys: ['whatsNew.v221.note1'],
  },
  {
    version: '2.2.0',
    date: '2026-08-18',
    noteKeys: [
      'whatsNew.v220.note1',
      'whatsNew.v220.note2',
      'whatsNew.v220.note3',
      'whatsNew.v220.note4',
    ],
  },
  {
    version: '2.1.2',
    date: '2026-08-18',
    noteKeys: ['whatsNew.v212.note1', 'whatsNew.v212.note2'],
  },
  {
    version: '2.1.1',
    date: '2026-08-18',
    noteKeys: ['whatsNew.v211.note1'],
  },
  {
    version: '2.1.0',
    date: '2026-08-18',
    noteKeys: [
      'whatsNew.v210.note1',
      'whatsNew.v210.note2',
      'whatsNew.v210.note3',
      'whatsNew.v210.note4',
    ],
  },
  {
    version: '2.0.4',
    date: '2026-08-18',
    noteKeys: ['whatsNew.v204.note1', 'whatsNew.v204.note2', 'whatsNew.v204.note3'],
  },
  {
    version: '2.0.3',
    date: '2026-08-18',
    noteKeys: ['whatsNew.v203.note1'],
  },
  {
    version: '2.0.2',
    date: '2026-08-18',
    noteKeys: ['whatsNew.v202.note1', 'whatsNew.v202.note2', 'whatsNew.v202.note3'],
  },
  {
    version: '2.0.1',
    date: '2026-08-18',
    noteKeys: ['whatsNew.v201.note1'],
  },
  {
    version: '2.0.0',
    date: '2026-08-18',
    noteKeys: [
      'whatsNew.v200.note1',
      'whatsNew.v200.note2',
      'whatsNew.v200.note3',
      'whatsNew.v200.note4',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-08-09',
    noteKeys: [
      'whatsNew.v150.note1',
      'whatsNew.v150.note2',
      'whatsNew.v150.note3',
      'whatsNew.v150.note4',
      'whatsNew.v150.note5',
      'whatsNew.v150.note6',
    ],
  },
  {
    version: '1.4.1',
    date: '2026-08-07',
    noteKeys: ['whatsNew.v141.note1'],
  },
  {
    version: '1.4.0',
    date: '2026-08-07',
    noteKeys: [
      'whatsNew.v140.note1',
      'whatsNew.v140.note2',
      'whatsNew.v140.note3',
      'whatsNew.v140.note4',
      'whatsNew.v140.note5',
      'whatsNew.v140.note6',
      'whatsNew.v140.note7',
      'whatsNew.v140.note8',
      'whatsNew.v140.note9',
      'whatsNew.v140.note10',
      'whatsNew.v140.note11',
      'whatsNew.v140.note12',
      'whatsNew.v140.note13',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-07-27',
    noteKeys: [
      'whatsNew.v130.note1',
      'whatsNew.v130.note2',
      'whatsNew.v130.note3',
      'whatsNew.v130.note4',
      'whatsNew.v130.note5',
      'whatsNew.v130.note6',
      'whatsNew.v130.note7',
      'whatsNew.v130.note8',
    ],
  },
]

export const CURRENT_VERSION = CHANGELOG_RELEASES[0].version
