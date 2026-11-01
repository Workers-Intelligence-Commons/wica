// The models the person may use, the Picker that chooses one for a new conversation and for the
// next turns of an open one, and the Picker of the reasoning level of the next message.

import type { ReasoningLevel } from '@wica/core'
import { Picker } from '@workers-intelligence-commons/components'
import { useEffect, useState } from 'react'

import { ProviderLogo } from './ProviderLogo.tsx'

/**
 * As `/api/models` sends it: `provider` picks the logo, `slug` is typed under the name, `levels`
 * are the reasoning levels it accepts.
 */
export type ModelOption = {
  id: string | null
  name: string
  group: string
  provider: string
  slug?: string
  levels: ReasoningLevel[]
}

/** The models the person may use: the instance's default first, then each provider's. */
export function useModels() {
  const [models, setModels] = useState<ModelOption[] | null>(null)
  useEffect(() => {
    void fetch('/api/models')
      .then((r) => r.json() as Promise<{ default: ModelOption | null; models: ModelOption[] }>)
      .then((body) => setModels([...(body.default ? [body.default] : []), ...body.models]))
      .catch(() => setModels([]))
  }, [])
  return models
}

/**
 * The Picker of the model. `value` is a `conversations.model` (`null`: the default model); a
 * model the list no longer offers stays shown under its identifier.
 */
export function ModelPicker(props: {
  models: ModelOption[] | null
  value: string | null
  onChange: (model: string | null) => void
}) {
  const options = (props.models ?? []).map((m) => ({
    value: m.id ?? '',
    label: m.name,
    group: m.group,
    ...(m.slug ? { slug: m.slug } : {}),
  }))
  const providerOf = new Map((props.models ?? []).map((m) => [m.group, m.provider]))
  const value = props.value ?? ''
  if (props.models && !options.some((o) => o.value === value)) {
    options.unshift({ value, label: props.value ?? 'Default model', group: 'Unavailable' })
  }
  return (
    <Picker
      label="Model"
      placement="above"
      placeholder="Loading models"
      options={options}
      value={props.models ? value : null}
      onChange={(v) => props.onChange(v || null)}
      disabled={!props.models}
      groupIcon={(group) => <ProviderLogo provider={providerOf.get(group) ?? ''} name={group} />}
    />
  )
}

const LEVEL_NAMES: Record<ReasoningLevel, string> = {
  off: 'No reasoning',
  minimal: 'Minimal reasoning',
  low: 'Low reasoning',
  medium: 'Medium reasoning',
  high: 'High reasoning',
  xhigh: 'Extra high reasoning',
  max: 'Max reasoning',
}

/** Levels of the model chosen by `model` (a `conversations.model`); empty while unknown. */
export const levelsOf = (models: ModelOption[] | null, model: string | null) =>
  models?.find((m) => (m.id ?? '') === (model ?? ''))?.levels ?? []

/**
 * The level kept for the next message among the levels of its model: the chosen one if the model
 * has it, else the provider's own choice.
 */
export const keptLevel = (level: ReasoningLevel | null, levels: ReasoningLevel[]) =>
  level && levels.includes(level) ? level : null

/**
 * The Picker of the reasoning level of the next message, among the levels of its model; absent
 * for a model that does not reason. `null` leaves the level to the provider.
 */
export function ReasoningPicker(props: {
  levels: ReasoningLevel[]
  value: ReasoningLevel | null
  onChange: (level: ReasoningLevel | null) => void
}) {
  if (props.levels.length === 0) return null
  const options = [
    { value: '', label: 'Default reasoning' },
    ...props.levels.map((l) => ({ value: l, label: LEVEL_NAMES[l] })),
  ]
  return (
    <Picker
      label="Reasoning"
      placement="above"
      options={options}
      value={props.value ?? ''}
      onChange={(v) => props.onChange(v === '' ? null : (v as ReasoningLevel))}
    />
  )
}
