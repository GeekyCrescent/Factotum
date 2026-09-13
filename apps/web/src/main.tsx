import { render } from 'preact'
import { Shell } from './shell.tsx'
import './style.css'

const root = document.getElementById('app')
if (root !== null) render(<Shell />, root)
