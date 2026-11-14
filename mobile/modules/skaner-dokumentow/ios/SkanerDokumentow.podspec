# Systemowy skaner dokumentów (VisionKit) dla aplikacji FaktWay, etap M9 planu
# aplikacji mobilnej. Moduł lokalny Expo (`mobile/modules/`), bez paczki z npm.
Pod::Spec.new do |s|
  s.name           = 'SkanerDokumentow'
  s.version        = '1.0.0'
  s.summary        = 'Skaner dokumentów VisionKit dla FaktWay'
  s.description    = 'Zdjęcie paragonu albo faktury przez systemowy skaner dokumentów: jedna strona jako JPG, kilka jako PDF.'
  s.license        = 'UNLICENSED'
  s.author         = 'FaktWay'
  s.homepage       = 'https://faktway.pl'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'VisionKit', 'UIKit'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
