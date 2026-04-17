import OnvoCheckout from './OnvoCheckout'
import './App.css'

function App() {
  return (
    <main style={{ maxWidth: 720, margin: '40px auto' }}>
      <OnvoCheckout monto={25} reservaId="RES-1001" />
    </main>
  )
}

export default App
