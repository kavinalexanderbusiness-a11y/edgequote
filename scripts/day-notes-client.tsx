import React from 'react'
import { createRoot } from 'react-dom/client'
import { FieldStopBar } from '../src/components/schedule/FieldStopBar'
import { fixtureJob, typicalJob } from './day-notes-fixture'

// The component is real; business callbacks are inert and never touch data.
createRoot(document.getElementById('field-stop-preview')!).render(
  <FieldStopBar job={document.documentElement.dataset.previewScenario === 'typical' ? typicalJob : fixtureJob} baseCoord={null} busy={false}
    onPrimary={() => undefined} onStop={() => undefined} />,
)
