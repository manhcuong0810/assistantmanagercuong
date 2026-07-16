import os
import sys
import json
import tempfile
import shutil
from PIL import Image
from pypdf import PdfWriter
from docx2pdf import convert
import docx

def decode_text(file_path):
    encodings = ['utf-8', 'utf-16', 'latin-1', 'windows-1252']
    for encoding in encodings:
        try:
            with open(file_path, 'r', encoding=encoding) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    raise ValueError("Cannot decode text file with standard encodings.")

def merge_files_to_pdf(merge_dir=None):
    if merge_dir is None:
        project_dir = os.path.dirname(os.path.abspath(__file__))
        merge_dir = os.path.join(project_dir, "merge_file")
        
    if not os.path.exists(merge_dir):
        os.makedirs(merge_dir, exist_ok=True)
    
    # Define Word Sandbox Directory to bypass macOS AppleScript/JXA sandbox restrictions
    word_temp_dir = os.path.expanduser("~/Library/Containers/com.microsoft.Word/Data")
    if not os.path.exists(word_temp_dir):
        word_temp_dir = tempfile.gettempdir()

    # 1. Scan directory
    ignored_names = {"app.js", "index.html", "style.css"}
    valid_extensions = {
        '.pdf', '.docx', '.doc', 
        '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
        '.txt', '.md', '.csv', '.json', '.js', '.html', '.css'
    }
    
    files = []
    for item in os.listdir(merge_dir):
        item_path = os.path.join(merge_dir, item)
        if os.path.isfile(item_path):
            if item in ignored_names:
                continue
            if item.startswith("merged_"):
                continue
            ext = os.path.splitext(item)[1].lower()
            if ext in valid_extensions:
                files.append(item)
                
    if not files:
        return {"success": False, "error": "No files to merge found in merge_file folder."}
        
    # Sort files alphabetically
    files.sort()
    
    temp_files = []
    pdf_paths = []
    
    try:
        for filename in files:
            file_path = os.path.join(merge_dir, filename)
            ext = os.path.splitext(filename)[1].lower()
            
            # Create a unique temp file path for the converted PDF
            fd, temp_pdf_path = tempfile.mkstemp(suffix=".pdf", dir=word_temp_dir)
            os.close(fd)
            temp_files.append(temp_pdf_path)
            
            if ext == '.pdf':
                # Direct PDF, just copy or append
                pdf_paths.append(file_path)
                # Remove the empty temp file
                os.remove(temp_pdf_path)
                temp_files.remove(temp_pdf_path)
                
            elif ext in ('.docx', '.doc'):
                # Copy docx/doc to temp directory (outside iCloud synced Desktop) to avoid macOS sandbox issues
                fd_docx, temp_docx_path = tempfile.mkstemp(suffix=ext, dir=word_temp_dir)
                os.close(fd_docx)
                temp_files.append(temp_docx_path)
                shutil.copy2(file_path, temp_docx_path)
                
                # Convert DOCX/DOC to PDF using Word via AppleScript
                convert(temp_docx_path, temp_pdf_path)
                pdf_paths.append(temp_pdf_path)
                
            elif ext in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'):
                # Convert Image to PDF
                img = Image.open(file_path)
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                img.save(temp_pdf_path, "PDF", resolution=100.0)
                pdf_paths.append(temp_pdf_path)
                
            elif ext in ('.txt', '.md', '.csv', '.json', '.js', '.html', '.css'):
                # Convert Text files to Word Docx, then to PDF
                text_content = decode_text(file_path)
                
                # Write to docx
                doc = docx.Document()
                doc.add_paragraph(text_content)
                
                fd_docx, temp_docx_path = tempfile.mkstemp(suffix=".docx", dir=word_temp_dir)
                os.close(fd_docx)
                temp_files.append(temp_docx_path)
                
                doc.save(temp_docx_path)
                
                # Convert to PDF
                convert(temp_docx_path, temp_pdf_path)
                pdf_paths.append(temp_pdf_path)
        
        # 2. Merge all PDFs
        output_pdf_path = os.path.join(merge_dir, "merged_document.pdf")
        
        merger = PdfWriter()
        for pdf_path in pdf_paths:
            merger.append(pdf_path)
            
        merger.write(output_pdf_path)
        merger.close()
        
        return {
            "success": True, 
            "merged_file": output_pdf_path, 
            "files_merged": files
        }
        
    except Exception as e:
        return {"success": False, "error": str(e)}
        
    finally:
        # Clean up temp files
        for temp_file in temp_files:
            try:
                if os.path.exists(temp_file):
                    os.remove(temp_file)
            except Exception:
                pass

if __name__ == "__main__":
    result = merge_files_to_pdf()
    print(json.dumps(result, ensure_ascii=False))
