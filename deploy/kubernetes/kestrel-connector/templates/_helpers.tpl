{{- define "kestrel-connector.namespace" -}}
{{- default "kestrel-system" .Values.namespaceOverride -}}
{{- end -}}

{{- define "kestrel-connector.image" -}}
{{- $repository := required "image.repository is required" .Values.image.repository -}}
{{- $digest := required "image.digest is required and must be sha256-pinned" .Values.image.digest -}}
{{- if contains "@" $repository -}}{{ fail "image.repository must not contain a digest" }}{{- end -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}{{ fail "image.digest must be an immutable sha256 digest" }}{{- end -}}
{{- $repository -}}@{{ $digest }}
{{- end -}}
