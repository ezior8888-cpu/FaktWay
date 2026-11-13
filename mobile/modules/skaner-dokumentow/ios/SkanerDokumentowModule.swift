import ExpoModulesCore
import UIKit
import VisionKit

/// Systemowy skaner dokumentów (VisionKit, `VNDocumentCameraViewController`):
/// wykrywa krawędzie kartki, prostuje ją i poprawia kontrast, więc odczyt
/// (OCR) dostaje czytelny dokument. Jedna strona to JPG, kilka stron to PDF
/// (serwer przyjmuje zdjęcie do 7 MB i PDF do 10 MB). Symulator nie ma
/// aparatu: `dostepny()` daje wtedy `false`, a aplikacja proponuje galerię.
public final class SkanerDokumentowModule: Module {
  private var trwajacy: DelegatSkanera?

  public func definition() -> ModuleDefinition {
    Name("SkanerDokumentow")

    Function("dostepny") { () -> Bool in
      VNDocumentCameraViewController.isSupported
    }

    AsyncFunction("skanuj") { (promise: Promise) in
      guard VNDocumentCameraViewController.isSupported else {
        promise.reject("E_SKANER_NIEDOSTEPNY", "Skaner dokumentów nie działa na tym urządzeniu.")
        return
      }
      guard self.trwajacy == nil else {
        promise.reject("E_SKANER_OTWARTY", "Skaner jest już otwarty.")
        return
      }
      var gora = SceneGeometry.keyWindow()?.rootViewController
      while let nad = gora?.presentedViewController {
        gora = nad
      }
      guard let ekran = gora else {
        promise.reject("E_SKANER_BRAK_EKRANU", "Nie można otworzyć skanera.")
        return
      }
      let delegat = DelegatSkanera(promise: promise) { [weak self] in
        self?.trwajacy = nil
      }
      self.trwajacy = delegat
      let skaner = VNDocumentCameraViewController()
      skaner.delegate = delegat
      skaner.modalPresentationStyle = .fullScreen
      ekran.present(skaner, animated: true)
    }
    .runOnQueue(.main)
  }
}

/// Najdłuższy bok strony w pikselach: paragon zostaje czytelny, a plik mały.
private let najdluzszyBok: CGFloat = 2200
/// Jakość JPG: kompromis rozmiaru i czytelności drobnego druku paragonu.
private let jakoscJpg: CGFloat = 0.72
/// Więcej stron nie wysyłamy z telefonu (faktura wielostronicowa: plik PDF na stronie).
private let najwiecejStron = 10

private final class DelegatSkanera: NSObject, VNDocumentCameraViewControllerDelegate {
  private let promise: Promise
  private let koniec: () -> Void

  init(promise: Promise, koniec: @escaping () -> Void) {
    self.promise = promise
    self.koniec = koniec
  }

  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
    let strony = (0..<min(scan.pageCount, najwiecejStron)).map { scan.imageOfPage(at: $0) }
    controller.dismiss(animated: true) {
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let wynik = try zapisz(strony: strony, wszystkich: scan.pageCount)
          self.promise.resolve(wynik)
        } catch {
          self.promise.reject("E_SKANER_ZAPIS", "Nie udało się zapisać skanu. Spróbuj jeszcze raz.")
        }
        DispatchQueue.main.async { self.koniec() }
      }
    }
  }

  func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
    controller.dismiss(animated: true) {
      self.promise.resolve(nil)
      self.koniec()
    }
  }

  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
    controller.dismiss(animated: true) {
      self.promise.reject("E_SKANER", "Skaner się zatrzymał. Spróbuj jeszcze raz albo wybierz zdjęcie z galerii.")
      self.koniec()
    }
  }
}

private enum BladZapisu: Error {
  case pusty
}

private func zmniejsz(_ obraz: UIImage) -> UIImage {
  let bok = max(obraz.size.width, obraz.size.height) * obraz.scale
  guard bok > najdluzszyBok else { return obraz }
  let skala = najdluzszyBok / bok
  let rozmiar = CGSize(width: (obraz.size.width * obraz.scale * skala).rounded(), height: (obraz.size.height * obraz.scale * skala).rounded())
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  return UIGraphicsImageRenderer(size: rozmiar, format: format).image { _ in
    obraz.draw(in: CGRect(origin: .zero, size: rozmiar))
  }
}

private func plik(_ rozszerzenie: String) -> URL {
  FileManager.default.temporaryDirectory.appendingPathComponent("skan-\(UUID().uuidString).\(rozszerzenie)")
}

/// Jedna strona: JPG. Kilka: PDF ze stronami w rozmiarze zdjęć (każda strona jako JPG w PDF).
private func zapisz(strony: [UIImage], wszystkich: Int) throws -> [String: Any] {
  guard let pierwsza = strony.first else { throw BladZapisu.pusty }
  if strony.count == 1 {
    guard let dane = zmniejsz(pierwsza).jpegData(compressionQuality: jakoscJpg) else { throw BladZapisu.pusty }
    let adres = plik("jpg")
    try dane.write(to: adres, options: .atomic)
    return ["uri": adres.absoluteString, "typ": "image/jpeg", "strony": 1, "wszystkichStron": wszystkich, "bajty": dane.count]
  }
  let adres = plik("pdf")
  let dokument = NSMutableData()
  UIGraphicsBeginPDFContextToData(dokument, .zero, nil)
  for strona in strony {
    let mala = zmniejsz(strona)
    guard let jpg = mala.jpegData(compressionQuality: jakoscJpg), let zJpg = UIImage(data: jpg) else { continue }
    let ramka = CGRect(origin: .zero, size: CGSize(width: zJpg.size.width * zJpg.scale, height: zJpg.size.height * zJpg.scale))
    UIGraphicsBeginPDFPageWithInfo(ramka, nil)
    zJpg.draw(in: ramka)
  }
  UIGraphicsEndPDFContext()
  guard dokument.length > 0 else { throw BladZapisu.pusty }
  try (dokument as Data).write(to: adres, options: .atomic)
  return ["uri": adres.absoluteString, "typ": "application/pdf", "strony": strony.count, "wszystkichStron": wszystkich, "bajty": dokument.length]
}
