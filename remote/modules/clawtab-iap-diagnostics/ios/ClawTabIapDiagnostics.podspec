Pod::Spec.new do |s|
  s.name = 'ClawTabIapDiagnostics'
  s.version = '1.0.0'
  s.summary = 'Local ClawTab purchase diagnostics'
  s.description = s.summary
  s.license = 'MIT'
  s.author = 'ClawTab'
  s.homepage = 'https://clawtab.cc'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/tgs-space/clawtab.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
