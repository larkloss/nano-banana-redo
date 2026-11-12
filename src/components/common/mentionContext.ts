import { createContext } from 'react'

// The reference photos a prompt box can point at with "@1", "@2", … —
// provided around the prompt editor, empty everywhere else
export interface MentionTarget {
  number: number
  name: string
  objectUrl: string
}

export const MentionContext = createContext<MentionTarget[]>([])
