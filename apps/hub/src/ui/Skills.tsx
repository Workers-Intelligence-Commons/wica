// The skills of the account, in the settings: the ones it sees, with where each comes from, and
// the form that publishes a skill as private, to an organization, or, for an admin, to the
// whole instance.

import {
  Button,
  SectionHeading,
  Select,
  Skeleton,
  TextArea,
  TextInput,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

type Skill = {
  id: string
  name: string
  description: string
  body: string
  visibility: 'private' | 'organization' | 'instance'
  organizationId: string | null
  removable: boolean
}
type Organization = { id: string; name: string }
type Listing = { skills: Skill[]; organizations: Organization[] }

export function Skills({ admin }: { admin: boolean }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const reload = useCallback(() => {
    void fetch('/api/skills')
      .then((r) => r.json() as Promise<Listing>)
      .then(setListing)
  }, [])
  useEffect(reload, [reload])

  const organizationName = (id: string | null) =>
    listing?.organizations.find((o) => o.id === id)?.name ?? 'an organization'
  const origin = (skill: Skill) =>
    skill.visibility === 'private'
      ? 'private'
      : skill.visibility === 'instance'
        ? 'the whole instance'
        : organizationName(skill.organizationId)

  return (
    <section className="panel">
      <SectionHeading level={3} kicker="instructions the model loads when they fit">
        Skills
      </SectionHeading>
      {listing === null ? <Skeleton lines={3} label="Loading skills" /> : null}
      <ul className="rows">
        {(listing?.skills ?? []).map((skill) => (
          <li key={skill.id} className="provider">
            <div className="inline">
              <span className="row-name">{skill.name}</span>
              <span className="row-detail">
                {origin(skill)} · {skill.description}
              </span>
              {skill.removable ? (
                <Button
                  variant="quiet"
                  onClick={() =>
                    void fetch(`/api/skills/${skill.id}`, { method: 'DELETE' }).then(reload)
                  }
                >
                  Remove
                </Button>
              ) : null}
            </div>
            <details>
              <summary>Instructions</summary>
              <pre>{skill.body}</pre>
            </details>
          </li>
        ))}
      </ul>
      {listing ? (
        <SkillForm organizations={listing.organizations} admin={admin} onDone={reload} />
      ) : null}
    </section>
  )
}

function SkillForm(props: { organizations: Organization[]; admin: boolean; onDone: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  /** `private`, `instance`, or the identifier of an organization. */
  const [place, setPlace] = useState('private')
  const [failed, setFailed] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const shared = place !== 'private' && place !== 'instance'
    const response = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        description,
        body,
        visibility: shared ? 'organization' : place,
        ...(shared ? { organizationId: place } : {}),
      }),
    })
    const answer = (await response.json().catch(() => ({}))) as { error?: string }
    setFailed(response.ok ? null : (answer.error ?? 'The skill was not saved.'))
    if (!response.ok) return
    setName('')
    setDescription('')
    setBody('')
    props.onDone()
  }

  return (
    <form onSubmit={submit}>
      <TextInput
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="lowercase letters, digits, single hyphens"
        required
      />
      <TextInput
        label="When to use it"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        required
      />
      <TextArea
        label="Instructions, in Markdown"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required
        error={failed}
      />
      <Select label="Who sees it" value={place} onChange={(e) => setPlace(e.target.value)}>
        <option value="private">Only you</option>
        {props.organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        {props.admin ? <option value="instance">Every account of the instance</option> : null}
      </Select>
      <Button type="submit">Save the skill</Button>
    </form>
  )
}
