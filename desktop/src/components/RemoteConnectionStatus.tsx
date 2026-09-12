type Props = {
  label: string
  phase: string
}

export let RemoteConnectionStatus = ({ label, phase }: Props) => <p className="remote-connection-status" role="status">
  <span className={`remote-connection-dot remote-connection-dot-${phase}`} aria-hidden="true" />
  <span>{label}</span>
</p>
