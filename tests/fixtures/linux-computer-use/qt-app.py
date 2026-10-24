import sys
from PyQt5.QtWidgets import QApplication, QWidget, QVBoxLayout, QLineEdit, QPushButton, QLabel
app = QApplication(sys.argv)
window = QWidget()
window.setWindowTitle("DSCODE Qt Fixture")
layout = QVBoxLayout(window)
entry = QLineEdit()
entry.setAccessibleName("Fixture input")
button = QPushButton("Apply fixture")
label = QLabel("Waiting")
for widget in [entry, button, label]:
    layout.addWidget(widget)
button.clicked.connect(lambda: label.setText("Applied: " + entry.text()))
window.resize(480, 260)
window.show()
app.exec()
