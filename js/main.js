function openAll() {
    var x = $('#list_urls').val().split('\n');
    for (var i = 0; i < x.length; i++)
if (x[i].indexOf('.') > 0)
if (x[i].indexOf('://') < 0)
	window.open('http://' + x[i]);
else
	window.open(x[i]);
    var popup = window.open('', '_blank');
     if(isPopupBlockerActivated(popup))
    {
      alert('Please allow Popup on your Browser for manual viewing!');
    }
}



var isPopupBlockerActivated = function(popupWindow) {
    if (popupWindow) {
        if (/chrome/.test(navigator.userAgent.toLowerCase())) {
            try {
                popupWindow.focus();
            } catch (e) {
                return true;
            }
        } else {
            popupWindow.onload = function() {
                return (popupWindow.innerHeight > 0) === false;
            };
        }
    } else {
        return true;
    }
    return false;
};
