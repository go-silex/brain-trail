/// <reference lib="dom" />
import './app.css'
import { startPage } from './page'

const app = document.getElementById('app')
const status = document.getElementById('status')
const toast = document.getElementById('toast')
if (app === null || status === null || toast === null)
  throw new Error('Brain Trail dashboard page is incomplete')
startPage(app, status, toast)
