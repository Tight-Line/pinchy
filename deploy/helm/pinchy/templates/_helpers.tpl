{{/*
Validate required values and fail early if missing.
*/}}
{{- define "pinchy.validateRequired" -}}
{{- if not .Values.postgresql.install -}}
  {{- if not .Values.postgresql.host -}}
  {{- fail "postgresql.host is required when postgresql.install is false." -}}
  {{- end -}}
{{- end -}}
{{- if .Values.ingress.enabled -}}
  {{- if not .Values.ingress.host -}}
  {{- fail "ingress.host is required when ingress is enabled." -}}
  {{- end -}}
{{- end -}}
{{- end -}}

{{/*
Name of the auto-managed secrets resource.
*/}}
{{- define "pinchy.secretName" -}}
{{- printf "%s-pinchy-secrets" .Release.Name -}}
{{- end -}}

{{/*
PostgreSQL host: internal service name when installed, else user-provided.
*/}}
{{- define "pinchy.pgHost" -}}
{{- if .Values.postgresql.install -}}
{{- printf "%s-postgresql" .Release.Name -}}
{{- else -}}
{{- .Values.postgresql.host -}}
{{- end -}}
{{- end -}}

{{/*
Secret name and key for the PostgreSQL password.
When postgresql.auth.existingSecret is set, use that; otherwise use our managed secret.
*/}}
{{- define "pinchy.pgSecretName" -}}
{{- if .Values.postgresql.auth.existingSecret -}}
{{- .Values.postgresql.auth.existingSecret -}}
{{- else -}}
{{- include "pinchy.secretName" . -}}
{{- end -}}
{{- end -}}

{{- define "pinchy.pgSecretKey" -}}
{{- if .Values.postgresql.auth.existingSecret -}}
{{- .Values.postgresql.auth.secretKey -}}
{{- else -}}
postgresql-password
{{- end -}}
{{- end -}}
