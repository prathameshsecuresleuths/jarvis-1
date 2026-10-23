import { useState } from 'react'
import { useStore } from '../store'

/**
 * Typing instead of talking.
 *
 * Voice is the point, but not always possible: a quiet room, a phone on the
 * tailnet with no wake word, a mic that has gone deaf. A typed line goes down
 * exactly the same path as a spoken one, so the answer is still spoken and
 * still puts up its panels. The global hotkeys already ignore keys pressed in
 * an input, so typing "g" here never switches the camera on.
 */
export function TypeBox({ onSend }: { onSend: (text: string) => void }) {
  const phase = useStore((s) => s.phase)
  const [text, text_] = useState('')
  const ready = phase !== 'offline' && phase !== 'boot'

  if (!ready) return null
  return (
    <form
      className="typebox"
      onSubmit={(e) => {
        e.preventDefault()
        const said = text.trim()
        if (!said) return
        onSend(said)
        text_('')
      }}
    >
      <input
        value={text}
        onChange={(e) => text_(e.target.value)}
        onKeyDown={(e) => {
          // Escape hands the keyboard back to the hotkeys (G, V, T, D).
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
        }}
        placeholder="Type to JARVIS · Enter to send"
        aria-label="Type a message to JARVIS"
        autoComplete="off"
        spellCheck
        maxLength={2000}
      />
    </form>
  )
}
