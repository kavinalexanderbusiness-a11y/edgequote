#!/usr/bin/env bash
# Mutation test: break each promise on purpose, and require the guard to notice.
# A guard nobody has tried to break is a guard nobody has tested.
# Every mutation is reverted with `git checkout --` on ITS OWN FILE only.
set -u
cd "$(dirname "$0")/.." || exit 1

pass=0; fail=0

# $1 label · $2 file · $3 perl mutation · $4 guard
mutate() {
  local label="$1" file="$2" prog="$3" guard="$4"
  # ⚠️ NORMALISE TO LF FIRST. The checkout is CRLF (core.autocrlf), so every
  # multi-line perl pattern written with \n silently matches NOTHING and the
  # mutation quietly does not apply — which would read as "the guard caught it"
  # if we only looked at the exit code. Same family as the comment-stripper trap
  # the guards themselves defend against. The baseline hash is taken AFTER
  # normalising, so "did the mutation apply" stays an honest question.
  perl -0pi -e 's/\r\n/\n/g' "$file"
  local before; before=$(md5sum < "$file")
  perl -0pi -e "$prog" "$file"
  local after; after=$(md5sum < "$file")
  if [ "$before" = "$after" ]; then
    echo "  ?? $label — MUTATION DID NOT APPLY (pattern missed; the test proves nothing)"
    fail=$((fail+1)); git checkout -- "$file"; return
  fi
  if npx tsx "scripts/verify-$guard.ts" >/dev/null 2>&1; then
    echo "  XX $label — guard STILL PASSED (verify:$guard does not catch this)"
    fail=$((fail+1))
  else
    echo "  ok $label — caught by verify:$guard"
    pass=$((pass+1))
  fi
  git checkout -- "$file"
}

echo ""
echo "=== 1. A customer can read the crew conversation ==="
mutate "portal RPC selects crew_messages" \
  supabase/CANONICAL-get_portal_data.sql \
  "s/'invoices', coalesce/'crew_chat', (select json_agg(m.body) from public.crew_messages m), 'invoices', coalesce/" \
  scoped-notes
mutate "QuotePDF renders a crew message" \
  src/components/quotes/QuotePDF.tsx \
  "s/export function QuoteDocument/const leak = (q: {crew_messages?: string}) => q.crew_messages\nexport function QuoteDocument/" \
  scoped-notes

echo ""
echo "=== 2. The tenant filter is removed ==="
mutate "crew_job_messages drops j.user_id = v_employer" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/where j\.id = p_job_id and j\.user_id = v_employer and j\.crew_id = v_crew;/where j.id = p_job_id and j.crew_id = v_crew;/" \
  crew-messages
mutate "the message read drops its tenant scope" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/where x\.job_id = v_job\.id and x\.user_id = v_employer/where x.job_id = v_job.id/" \
  crew-messages
mutate "the owner insert policy stops proving the visit is theirs" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/  with check \(\n    auth\.uid\(\) = user_id\n    and exists \(select 1 from public\.jobs j where j\.id = job_id and j\.user_id = auth\.uid\(\)\)\n  \);/  with check (auth.uid() = user_id);/" \
  crew-messages
mutate "the crew write takes its tenant from the caller" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/values \(v_employer, v_job, v_body, 'crew'/values (auth.uid(), v_job, v_body, 'crew'/" \
  crew-messages

echo ""
echo "=== 3. An unassigned worker gains access ==="
mutate "crew_job_messages drops j.crew_id = v_crew" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/where j\.id = p_job_id and j\.user_id = v_employer and j\.crew_id = v_crew;/where j.id = p_job_id and j.user_id = v_employer;/" \
  crew-messages
mutate "crew_post_message drops the crew clause" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/   where j\.id = p_job_id and j\.user_id = v_employer and j\.crew_id = v_crew;/   where j.id = p_job_id and j.user_id = v_employer;/" \
  crew-messages
mutate "the inbox stops scoping to this worker's crew" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/         and j\.crew_id = v_crew\n         and m\.created_at/         and m.created_at/" \
  crew-messages
mutate "a revoked worker gets an empty day instead of NULL" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/  if v_employer is null or v_crew is null then\n    return null;                       -- revoked: not an active crew member\n  end if;//" \
  crew-messages
mutate "the identity trigger stops checking the employer" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/  if public\.crew_employer\(\) is distinct from new\.user_id then\n    raise exception 'you cannot post to that visit' using errcode = '42501';\n  end if;//" \
  crew-messages
mutate "the upload door stops proving the crew assignment" \
  src/app/api/crew/media/route.ts \
  "s/\.eq\('user_id', t\.user_id\)\.eq\('crew_id', t\.crew_id\)/.eq('user_id', t.user_id)/g" \
  crew-messages
mutate "the upload door stops proving the message is on that visit" \
  src/app/api/crew/media/route.ts \
  "s/\.eq\('id', messageId\)\.eq\('job_id', j\.id\)\.eq\('user_id', j\.user_id\)/.eq('id', messageId)/" \
  crew-messages

echo ""
echo "=== 4. A failed send is shown as successful ==="
mutate "the crew screen appends the typed text, not the server's row" \
  src/components/crew/CrewStopConversation.tsx \
  "s/setMessages\(prev => prev\.some\(m => m\.id === res\.message\.id\) \? prev : \[\.\.\.prev, res\.message\]\)/setMessages(prev => [...prev, res.message])/" \
  crew-messages
mutate "the outbox loses its failed state" \
  src/components/conversation/ConversationView.tsx \
  "s/p\.state === 'failed' \? 'border-red-500\/50 bg-red-500\/10' : 'border-border bg-bg-tertiary\/40 opacity-70'/'border-border'/" \
  crew-messages
mutate "a failed read renders as an empty conversation" \
  src/components/conversation/ConversationView.tsx \
  "s/\{!loading && !loadError && messages\.length === 0 && pending\.length === 0 && \(/{!loading \&\& (/" \
  crew-messages
mutate "the view starts writing messages itself" \
  src/components/conversation/ConversationView.tsx \
  "s/const \[text, setText\] = useState\(''\)/const [text, setText] = useState('')\n  const setMessages = (x: unknown) => x/" \
  crew-messages
mutate "dead-signal error is folded into revoked" \
  src/lib/crewMessages.ts \
  "s/  if \(error\) return \{ kind: 'error', message: error\.message \}\n  if \(!data\) return \{ kind: 'revoked' \}\n  const d = data as \{ ok: boolean; reason\?: string \} & CrewConversation/  if (error) return { kind: 'revoked' }\n  if (!data) return { kind: 'revoked' }\n  const d = data as { ok: boolean; reason?: string } \& CrewConversation/" \
  crew-messages

echo ""
echo "=== 5. A duplicate send is accepted ==="
mutate "the replay index is dropped" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/create unique index if not exists crew_messages_client_token_key/create index if not exists crew_messages_client_token_key/" \
  crew-messages
mutate "the index loses its partial clause" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/  on public\.crew_messages \(job_id, created_by, client_token\)\n  where client_token is not null;/  on public.crew_messages (job_id, created_by, client_token);/" \
  crew-messages
mutate "the write stops handling the replay" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/  on conflict \(job_id, created_by, client_token\) where client_token is not null do nothing\n//" \
  crew-messages
mutate "the token is minted per ATTEMPT instead of per message" \
  src/components/crew/CrewStopConversation.tsx \
  "s/    const res = await postCrewMessage\(supabase, jobId, entry\.body, entry\.token\)/    const res = await postCrewMessage(supabase, jobId, entry.body, newClientToken())/" \
  crew-messages

echo ""
echo "=== 6. Private media becomes public ==="
mutate "the media door hands out a public URL" \
  src/app/api/crew/media/route.ts \
  "s/const \{ data: signed, error: signErr \} = await admin\.storage\.from\(CREW_MEDIA_BUCKET\)\n    \.createSignedUrls\(media\.map\(m => m\.storage_path\), SIGNED_URL_SECONDS\)/const signErr = null\n  const signed = media.map(m => ({ path: m.storage_path, signedUrl: admin.storage.from(CREW_MEDIA_BUCKET).getPublicUrl(m.storage_path).data.publicUrl }))/" \
  crew-messages
mutate "message attachments leak into the work instructions" \
  src/lib/crewMedia.ts \
  "s/    \.is\('message_id', null\)\n    \.order\('created_at', \{ ascending: true \}\)/    .order('created_at', { ascending: true })/" \
  crew-messages
mutate "the crew instructions view stops filtering attachments" \
  src/components/crew/CrewStopMedia.tsx \
  "s/const media = \(\(d\.media \|\| \[\]\) as MediaItem\[\]\)\.filter\(m => !m\.message_id\)/const media = (d.media || []) as MediaItem[]/" \
  crew-messages

echo ""
echo "=== 7. Controls: the system-event and notification rules ==="
mutate "a system event starts a conversation instead of joining one" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/  if not exists \(select 1 from public\.crew_messages m where m\.job_id = new\.id\) then\n    return new;                        -- no conversation to join\n  end if;//" \
  crew-messages
mutate "the owner is notified of their own messages" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/  if new\.author_kind <> 'crew' then\n    return new;\n  end if;//" \
  crew-messages
mutate "the bell is deduped for all time, silencing every reply after the first" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/       and n\.entity_id = new\.job_id and n\.read = false/       and n.entity_id = new.job_id/" \
  crew-messages
mutate "unread starts counting system lines (owner badged for own reschedule)" \
  src/lib/crewMessages.ts \
  "s/  return messages\.filter\(m => isAttentionWorthy\(m\) && Date\.parse\(m\.created_at\) > mark\)\.length/  return messages.filter(m => !m.mine \&\& Date.parse(m.created_at) > mark).length/" \
  crew-messages
mutate "the read mark is stamped at now() instead of the newest message" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/    values \(v_employer, v_job\.id, v_uid, v_high\)/    values (v_employer, v_job.id, v_uid, now())/" \
  crew-messages
mutate "the crew screen queries the table directly" \
  src/components/crew/CrewInbox.tsx \
  "s/import \{ ConversationView/const leak = (s: {from: (t: string) => unknown}) => s.from('crew_messages')\nimport { ConversationView/" \
  crew-access
mutate "anon keeps its default grant on the conversation" \
  supabase/RUN-2026-08-13-crew-messages.sql \
  "s/revoke all on public\.crew_messages      from anon;//" \
  crew-messages

echo ""
echo "───────────────────────────────────────────────"
echo "caught: $pass   escaped/misfired: $fail"
[ "$fail" -eq 0 ] || exit 1
