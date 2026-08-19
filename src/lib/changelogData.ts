import type { MessageKey } from './i18n'

export type ChangelogRelease = {
  version: string
  date: string
  noteKeys: MessageKey[]
}

export const CHANGELOG_RELEASES: ChangelogRelease[] = [
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
